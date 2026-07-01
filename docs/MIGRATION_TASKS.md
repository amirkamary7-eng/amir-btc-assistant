# ادامه کار مهاجرت

## نقطه‌ای که پروژه در آن متوقف شده بود

بر اساس وضعیت فعلی مخزن و چیزی که در اسکرین‌شات دیده می‌شود، پروژه در انتهای فاز مستندسازی متوقف شده بود:

- منطق `/start` قبلاً بازنویسی و تثبیت شده است.
- اسناد پایه شامل `docs/API_MAP.md`، `docs/DATABASE_SCHEMA.md`، `docs/MIGRATION_STATUS.md` و `docs/PROJECT_ARCHITECTURE.md` موجود هستند.
- سند `docs/CLOUDFLARE_PLAN.md` نیز مسیر هدف را تعریف کرده است.

پس ادامه‌ی طبیعی پروژه از اینجا، ورود به فاز طراحی اجرایی و سپس ساخت shell مهاجرت است؛ نه تغییرات پراکنده در UI یا دست‌کاری هم‌زمان چند بخش unrelated.

## ترتیب پیشنهادی ادامه کار

### 1. تثبیت shell سمت Cloudflare

هدف:

- ساخت یک baseline کم‌ریسک برای اجرا و تست

فایل‌ها/بخش‌های درگیر:

- `worker-proxy.js`
- `wrangler.jsonc`
- فایل‌های فرانت مثل `index.html` و `app.js`

خروجی مورد انتظار:

- یک Worker اصلی با routing مشخص برای `/api/*` و `/telegram`
- یک تنظیم مشخص برای Pages یا استقرار فایل‌های استاتیک
- envها و secretهای لازم به‌صورت شفاف

### 2. انتقال endpointهای public و کم‌ریسک

اولویت:

- `GET /api/health`
- `GET /api/charts/resolve`
- `GET /api/calendar/events`
- `GET /api/farsi-news`
- `GET /api/analyses`

فایل‌های مرجع فعلی:

- `main.py`
- `backend/routers/charts.py`
- `backend/routers/calendar.py`
- `backend/routers/analyses.py`
- `backend/services/chart_service.py`
- `backend/services/calendar_service.py`

دلیل شروع از این بخش:

- این endpointها برای شکستن contract ریسک کمتری دارند.
- وابستگی آن‌ها به state حساس کاربر کمتر است.

### 3. انتقال auth و user flow

اولویت:

- `backend/services/telegram_auth.py`
- `backend/routers/users.py`
- `backend/routers/watchlist.py`
- بخش `apiFetch` در `app.js`

نکات حساس:

- هدر `X-Telegram-Init-Data` باید بدون تغییر حفظ شود.
- race condition مربوط به آماده شدن `Telegram.WebApp` نباید دوباره ایجاد شود.
- هیچ تغییری در contract فرانت سمت Mini App نباید اعمال شود.

### 4. انتقال mandatory join

اولویت:

- `GET /api/check-join`
- `GET /api/debug/check-join`
- `POST /api/check-join/invalidate`

فایل‌های مرجع:

- `backend/services/join_service.py`
- `backend/services/user_service.py`
- `main.py`
- فرانت مربوط به `#mandatory-join-overlay`

نکات حساس:

- `users.channel_joined` باید source of truth باقی بماند.
- overlay فعلی و رفتار قفل‌کننده‌ی رابط نباید تغییر کند.

### 5. انتقال webhook و `/start`

اولویت:

- `POST /telegram`
- handler دستور `/start`

فایل‌های مرجع:

- `main.py`
- `bot.py`

نکات حساس:

- رفتار جدید `/start` که بر مبنای `channel_joined` است باید بدون تغییر حفظ شود.
- دکمه `web_app` فقط برای کاربر عضو نمایش داده شود.

### 6. حذف state فایل‌محور

اولویت:

- حذف وابستگی به `data/alerts.json`
- حذف وابستگی به `tickets.json` پس از اتصال کامل به DB

فایل‌های مرجع:

- `main.py`
- `backend/models.py`
- سرویس‌های مرتبط با تیکت و هشدار

نکات حساس:

- این بخش باید بعد از تثبیت endpointهای اصلی انجام شود.
- انتقال مستقیم و بدون بررسی داده‌های موجود ریسک‌دار است.

## اولین تسک اجرایی پیشنهادی

اگر بخواهیم دقیقاً از همین‌جا ادامه بدهیم، اولین کار اجرایی کم‌ریسک این است:

1. بازبینی و بازسازی `worker-proxy.js` و تنظیمات `wrangler`
2. تعریف یک Worker baseline برای `GET /api/health`
3. جدا کردن configهای لازم برای اتصال فرانت به API جدید بدون شکستن نسخه فعلی

این نقطه بهترین شروع است چون:

- هنوز وارد auth و join و webhook نشده‌ایم
- امکان تست زودهنگام deployment می‌دهد
- ریسک کمی برای رفتار فعلی کاربر نهایی دارد

## جمع‌بندی

نقطه توقف پروژه در اسکرین‌شات، انتهای فاز مستندسازی و آغاز فاز تبدیل مستندات به کار اجرایی بوده است. بنابراین ادامه‌ی درست پروژه از اینجا، شروع ساخت shell مهاجرت Cloudflare و انتقال endpointهای کم‌ریسک است.

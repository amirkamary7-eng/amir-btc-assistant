# وضعیت مهاجرت پروژه

این سند برای ارائه وضعیت مهاجرت نگه‌داری می‌شود، اما وضعیت رسمی و یکپارچه پروژه در `PROJECT_STATUS.md` و جزئیات اجرایی در `PROGRESS.md` ثبت می‌شود.

## وضعیت فعلی پروژه

پروژه در حال حاضر عملیاتی است و اجزای اصلی زیر را دارد:

- بک‌اند اصلی با FastAPI و Python
- Telegram Bot در webhook mode
- Telegram Mini App
- PostgreSQL روی Supabase
- Redis برای cache
- Cloudflare Pages برای فایل‌های استاتیک (خروجی `webapp/pages-dist`)
- Cloudflare Worker Shell در `worker-proxy.js` (ترکیبی از مسیرهای Worker-native و proxy به upstream)
- KV namespaceها و cron trigger برای baseline مهاجرت وجود دارد

## وضعیت کلی مهاجرت

- **هدف نهایی:** حذف کامل Render و انتقال به معماری Cloudflare + Supabase
- **وضعیت فعلی:** مهاجرت عملی شروع شده و یک Worker Shell فعال در مخزن وجود دارد، اما هنوز همه‌ی APIها و stateهای حساس روی Worker-native منتقل نشده‌اند.
- **فاز فعلی:** انتقال مرحله‌ای (Phase 3/4/5/6 به‌صورت همپوشان و partial)
- **ریسک فعلی:** متوسط، چون مسیرهای حساس به upstream (`BACKEND_URL`) وابسته‌اند و حذف کامل backend هنوز انجام نشده است.

## فازهای مهاجرت

### Phase 0: شناخت و تحلیل

وضعیت:

- انجام شده

خروجی:

- تحلیل ساختار پروژه
- تحلیل APIها
- تحلیل وابستگی‌ها
- تحلیل دیتابیس
- تحلیل نقاط وابسته به Render
- تحلیل ریسک‌های مهاجرت

### Phase 1: مستندسازی

وضعیت:

- انجام شده

خروجی مورد انتظار:

- `docs/PROJECT_ARCHITECTURE.md`
- `docs/MIGRATION_STATUS.md`
- `docs/API_MAP.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/CLOUDFLARE_PLAN.md`

### Phase 2: طراحی مهاجرت مرحله‌ای

وضعیت:

- partial

خروجی مورد انتظار:

- برنامه مهاجرت کم‌ریسک
- تعیین ترتیب انتقال سرویس‌ها
- تعیین rollback plan
- تعیین تست‌های هر مرحله

### Phase 3: آماده‌سازی زیرساخت Cloudflare

وضعیت:

- partial

خروجی مورد انتظار:

- ساختار Pages
- ساختار Worker API
- KV namespaceها
- Cron jobs
- secrets و envها
- routes و custom domain planning

### Phase 4: انتقال APIها

وضعیت:

- partial

خروجی مورد انتظار:

- انتقال تدریجی endpointها به Cloudflare Worker
- حفظ کامل contract فعلی API
- سازگاری کامل با Mini App

### Phase 5: انتقال webhook ربات

وضعیت:

- partial

خروجی مورد انتظار:

- اجرای webhook روی Cloudflare Worker
- حذف وابستگی webhook به Render

### Phase 6: انتقال cache

وضعیت:

- partial

خروجی مورد انتظار:

- جایگزینی Redis با KV
- جایگزینی in-memory fallback با storage سازگار با Cloudflare

### Phase 7: انتقال stateهای فایل‌محور

وضعیت:

- not started

خروجی مورد انتظار:

- انتقال `tickets.json` به storage پایدار
- انتقال `alerts.json` به storage پایدار
- حذف وابستگی به فایل‌سیستم محلی

### Phase 8: حذف کامل Render

وضعیت:

- partial

خروجی مورد انتظار:

- قطع کامل وابستگی runtime به Render
- انتقال کامل API و webhook
- به‌روزرسانی URLها و envها

## فاز فعلی

**فازهای فعال به‌صورت هم‌زمان (با اولویت اجرایی Phase 4)**

هدف این فاز:

- تبدیل مستندات فاز قبل به تسک‌های اجرایی مشخص
- تعیین ترتیب کم‌ریسک انتقال بخش‌ها
- مشخص کردن bindingها، storageها و نقاط cutover
- آماده‌سازی مبنای شروع پیاده‌سازی

## فاز بعدی

**تکمیل Phase 4/6/7 و قطع نیاز به upstream**

تمرکز فاز بعدی:

- ساخت shell اولیه Pages و Worker
- تعریف KV namespaceها و envها
- آماده‌سازی مسیر تست و استقرار اولیه

## کارهای انجام‌شده تا این لحظه

- تحلیل کامل ساختار فعلی پروژه
- تحلیل مسیرهای Backend
- تحلیل webhook ربات
- تحلیل Telegram auth
- تحلیل سیستم join اجباری
- تحلیل ساختار DB و مدل‌ها
- تحلیل وابستگی‌های Render
- تحلیل وضعیت فعلی Cloudflare artifacts
- تکمیل مستندسازی رسمی پروژه
- تکمیل `docs/PROJECT_ARCHITECTURE.md`
- تکمیل `docs/API_MAP.md`
- تکمیل `docs/DATABASE_SCHEMA.md`
- تکمیل `docs/CLOUDFLARE_PLAN.md`
- پیاده‌سازی Cloudflare Worker Shell در `worker-proxy.js`
- پیاده‌سازی Worker-native برای endpointهای پایه و public (از جمله `/api/health`, `/api/charts/resolve`, `/api/calendar/events`, `/api/farsi-news`)
- پیاده‌سازی join gate روی Worker (`/api/check-join*`) با KV + Telegram API + DB (در صورت وجود)
- اضافه شدن پیکربندی‌های Wrangler (`wrangler.jsonc`, `wrangler.pages.jsonc`) و bindingهای KV + cron trigger
- حذف hardcode آدرس‌های onrender از فایل‌های runtime (API_BASE و config)

## کارهای باقی‌مانده

### کارهای تحلیلی/طراحی

- نهایی‌سازی برنامه مهاجرت مرحله‌ای بر اساس وضعیت واقعی کد (کاهش proxy و تعریف cutover)
- تعیین rollout/rollback plan برای جایگزینی مرحله‌ای upstream

### کارهای زیرساختی

- نهایی‌سازی secret management و bindingها در محیط‌های staging/production
- تعیین دامنه/route نهایی برای Pages و Worker و برنامه cutover

### کارهای فنی مهاجرت

- تکمیل انتقال endpointهای باقی‌مانده به Worker-native (حذف proxy در مسیرهای حساس)
- تکمیل webhook روی Worker برای کل رفتارهای لازم (در حال حاضر تمرکز روی `/start` است)
- تکمیل مهاجرت cache در کل سیستم (حذف Redis از مسیرهای production)
- انتقال tickets/alerts از فایل‌های JSON به DB-backed flow
- قطع وابستگی به upstream (`BACKEND_URL`) پس از تکمیل endpointها
- تست کامل Mini App
- تست کامل ربات

## وضعیت قابلیت‌های حساس

### قابلیت‌هایی که باید بدون تغییر حفظ شوند

- Telegram Bot behavior
- `/start`
- Mini App behavior
- mandatory join flow
- watchlist
- user profile
- tickets
- admin panel
- notifications
- assistant
- referral system
- analyses
- economic calendar

### قابلیت‌هایی که در مهاجرت ریسک بالاتری دارند

- webhook bot
- alerts polling
- file-based tickets
- file-based alerts
- Redis-dependent session tracking
- cache semantics

## موانع مهم شناسایی‌شده

- runtime فعلی backend به Python/FastAPI وابسته است
- Python Workers برای این stack گزینه کم‌ریسکی نیست
- بخشی از state هنوز file-based است
- برای بخش‌هایی از API هنوز از proxy به upstream (`BACKEND_URL`) استفاده می‌شود

## معیار تکمیل مهاجرت

مهاجرت زمانی کامل تلقی می‌شود که:

- هیچ endpoint عملیاتی روی upstream قدیمی (از جمله Render) نمانده باشد
- webhook تلگرام روی Cloudflare اجرا شود
- Mini App فقط به Cloudflare API متصل باشد
- کش روی KV یا معادل Cloudflare منتقل شده باشد
- stateهای موقتی روی storage پایدار باشند
- رفتار ربات و Mini App نسبت به قبل تغییر نکند
- API contract موجود حفظ شده باشد

# وضعیت مهاجرت پروژه

## وضعیت فعلی پروژه

پروژه در حال حاضر عملیاتی است و اجزای اصلی زیر را دارد:

- بک‌اند اصلی با FastAPI و Python
- Telegram Bot در webhook mode
- Telegram Mini App
- PostgreSQL روی Supabase
- Redis برای cache
- بخشی از استقرار روی Render
- آثار و فایل‌های مربوط به Cloudflare Worker proxy

## وضعیت کلی مهاجرت

- **هدف نهایی:** حذف کامل Render و انتقال به معماری Cloudflare + Supabase
- **وضعیت فعلی:** هنوز مهاجرت عملی شروع نشده است
- **فاز فعلی:** مستندسازی و تحلیل
- **ریسک فعلی:** متوسط تا بالا، چون runtime اصلی هنوز به Render و FastAPI/Python وابسته است

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

- هنوز شروع نشده

خروجی مورد انتظار:

- برنامه مهاجرت کم‌ریسک
- تعیین ترتیب انتقال سرویس‌ها
- تعیین rollback plan
- تعیین تست‌های هر مرحله

### Phase 3: آماده‌سازی زیرساخت Cloudflare

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- ساختار Pages
- ساختار Worker API
- KV namespaceها
- Cron jobs
- secrets و envها
- routes و custom domain planning

### Phase 4: انتقال APIها

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- انتقال تدریجی endpointها به Cloudflare Worker
- حفظ کامل contract فعلی API
- سازگاری کامل با Mini App

### Phase 5: انتقال webhook ربات

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- اجرای webhook روی Cloudflare Worker
- حذف وابستگی webhook به Render

### Phase 6: انتقال cache

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- جایگزینی Redis با KV
- جایگزینی in-memory fallback با storage سازگار با Cloudflare

### Phase 7: انتقال stateهای فایل‌محور

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- انتقال `tickets.json` به storage پایدار
- انتقال `alerts.json` به storage پایدار
- حذف وابستگی به فایل‌سیستم محلی

### Phase 8: حذف کامل Render

وضعیت:

- هنوز شروع نشده

خروجی مورد انتظار:

- قطع کامل وابستگی runtime به Render
- انتقال کامل API و webhook
- به‌روزرسانی URLها و envها

## فاز فعلی

**Phase 2: طراحی برنامه مهاجرت مرحله‌ای و کم‌ریسک**

هدف این فاز:

- تبدیل مستندات فاز قبل به تسک‌های اجرایی مشخص
- تعیین ترتیب کم‌ریسک انتقال بخش‌ها
- مشخص کردن bindingها، storageها و نقاط cutover
- آماده‌سازی مبنای شروع پیاده‌سازی

## فاز بعدی

**Phase 3: آماده‌سازی زیرساخت Cloudflare**

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

## کارهای باقی‌مانده

### کارهای تحلیلی/طراحی

- نهایی‌سازی برنامه مهاجرت مرحله‌ای
- تعیین storage strategy برای stateهای موقت
- تعیین strategy برای online sessions
- تعیین strategy برای alerts polling
- شکستن طرح مهاجرت به تسک‌های اجرایی فایل‌به‌فایل

### کارهای زیرساختی

- تعریف Cloudflare Pages target
- تعریف Worker API target
- تعریف KV namespaceها
- تعریف Cron Triggerها
- تعریف secret management

### کارهای فنی مهاجرت

- انتقال endpointها
- انتقال webhook
- انتقال cache
- انتقال state file-based
- حذف URLهای Render از frontend/env
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
- URLهای Render هنوز در frontend و env وجود دارند
- Cloudflare فعلی در repo هنوز جایگزین backend نشده است

## معیار تکمیل مهاجرت

مهاجرت زمانی کامل تلقی می‌شود که:

- هیچ endpoint عملیاتی روی Render نمانده باشد
- webhook تلگرام روی Cloudflare اجرا شود
- Mini App فقط به Cloudflare API متصل باشد
- کش روی KV یا معادل Cloudflare منتقل شده باشد
- stateهای موقتی روی storage پایدار باشند
- رفتار ربات و Mini App نسبت به قبل تغییر نکند
- API contract موجود حفظ شده باشد

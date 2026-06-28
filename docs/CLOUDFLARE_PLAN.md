# برنامه Cloudflare

## هدف این سند

این سند معماری هدف برای حذف کامل Render و انتقال پروژه به Cloudflare + Supabase را بر اساس وضعیت واقعی فعلی پروژه تعریف می‌کند.

این سند:

- معماری هدف را مشخص می‌کند
- اجزای Cloudflare مورد نیاز را تعیین می‌کند
- نقش Pages، Workers، KV و Durable Objects را تعریف می‌کند
- ترتیب مهاجرت مرحله‌ای را مشخص می‌کند

## اصل‌های طراحی

- هیچ endpoint فعلی نباید بشکند
- هیچ قابلیت فعلی نباید حذف شود
- Supabase منبع اصلی داده باقی بماند
- Redis با Cloudflare-native cache جایگزین شود
- webhook ربات به Cloudflare Worker منتقل شود
- Mini App بدون تغییر رفتاری ادامه دهد
- mandatory join بدون افت عملکرد حفظ شود
- تغییرات با حداقل ریسک و به‌صورت مرحله‌ای انجام شوند

## وضعیت فنی مهم قبل از طراحی

### 1. چرا FastAPI فعلی مستقیماً target نهایی Cloudflare نیست

پروژه فعلی روی Python/FastAPI و کتابخانه‌هایی مثل:

- `fastapi`
- `python-telegram-bot`
- `sqlalchemy`
- `psycopg2-binary`
- `redis`

تکیه دارد.

برای معماری نهایی Cloudflare:

- اجرای مستقیم همین stack روی Cloudflare Workers مسیر کم‌ریسکی نیست
- معماری هدف باید Worker-native باشد
- منطق فعلی باید حفظ شود، اما runtime باید به Workers بازطراحی شود

### 2. نتیجه عملی

معماری نهایی پیشنهادی:

- Frontend روی Cloudflare Pages
- API روی Cloudflare Workers
- Cache روی Cloudflare KV
- حضور بلادرنگ فقط در صورت نیاز روی Durable Objects
- دیتابیس اصلی روی Supabase PostgreSQL

## معماری هدف

```text
Telegram User
   │
   ├── Telegram Bot
   │      │
   │      └── Webhook -> Cloudflare Worker
   │
   └── Telegram Mini App
          │
          └── Cloudflare Pages
                   │
                   └── API Calls -> Cloudflare Worker API
                                      │
                                      ├── Supabase PostgreSQL
                                      ├── Cloudflare KV
                                      ├── Telegram Bot API
                                      ├── External Market/News APIs
                                      └── Durable Objects (only if needed)
```

## اجزای معماری هدف

### 1. Cloudflare Pages

نقش:

- میزبانی فایل‌های استاتیک Mini App
- ارائه frontend روی دامنه Cloudflare

فایل‌های target:

- `index.html`
- `app.js`
- `style.css`
- `assistant.js`
- `notifications.js`
- `watchlist.js`
- `assets/*`

تغییرات موردنیاز:

- حذف URLهای Render از frontend
- تنظیم `API_BASE` به دامنه Worker/API
- حفظ کامل contract فعلی فرانت

### 2. Cloudflare Worker API

نقش:

- جایگزین backend فعلی FastAPI
- ارائه تمام endpointهای `/api/*`
- ارائه مسیر `/telegram`
- مدیریت auth، join-check، notifications، alerts، sessions، assistant و admin routes

مسیرهای اصلی:

- `/api/users/*`
- `/api/watchlist`
- `/api/charts/resolve`
- `/api/analyses`
- `/api/calendar/events`
- `/api/referrals/*`
- `/api/sessions/*`
- `/api/assistant/*`
- `/api/check-join*`
- `/api/tickets*`
- `/api/alerts*`
- `/api/notify`
- `/api/farsi-news`
- `/telegram`

### 3. Supabase PostgreSQL

نقش:

- منبع اصلی داده برای تمام business entities

جداولی که باید منبع اصلی باقی بمانند:

- `users`
- `watchlist_items`
- `analyses`
- `referrals`
- `token_balances`
- `token_transactions`

جداولی که بهتر است رسماً فعال شوند:

- `tickets`
- `ticket_replies`
- `price_alerts`

نتیجه:

- Supabase باید source of truth برای داده‌های پایدار باقی بماند
- از مهاجرت schema غیرضروری باید پرهیز شود

### 4. Cloudflare KV

نقش:

- جایگزین cache فعلی Redis
- storage سبک و read-heavy

namespaceهای پیشنهادی:

- `JOIN_CACHE`
  - cache وضعیت عضویت کاربران
- `APP_CACHE`
  - cache اخبار
  - cache تقویم اقتصادی
  - cache chart exchange resolution
  - cache analysis metadata/version
- `RATE_LIMITS`
  - cache نرخ درخواست و cooldownهای AI
- `SESSION_CACHE`
  - اگر DO استفاده نشود، برای session presence تقریبی

استفاده‌های مناسب KV:

- key/value با TTL
- cache read-heavy
- metadata سبک

استفاده‌های نامناسب KV:

- شمارش strongly consistent بلادرنگ
- state پیچیده تراکنشی
- queue جایگزین

### 5. Durable Objects

نقش:

- فقط در صورت نیاز

پیشنهاد فعلی:

- برای core business data استفاده نشود
- فقط اگر حضور آنلاین دقیق، coordination بلادرنگ یا state زنده لازم باشد استفاده شود

کاندیداهای احتمالی:

- `PresenceDO`
  - برای session/online count با دقت بیشتر
- `AlertCoordinatorDO`
  - فقط اگر بعداً نیاز به orchestration هم‌زمان یا batching خاص ایجاد شود

تصمیم فعلی:

- Durable Objects برای مرحله اول مهاجرت ضروری نیستند
- استفاده از آن‌ها فقط بعد از migration baseline و در صورت نیاز واقعی توصیه می‌شود

### 6. Cron Triggers

نقش:

- جایگزین `alert_polling_loop()`
- اجرای jobهای دوره‌ای serverless

مصارف پیشنهادی:

- پردازش دوره‌ای price alerts
- refresh برخی cacheهای غیرحساس در صورت نیاز

### 7. Secrets و Envها

روی Cloudflare باید secrets زیر تعریف شوند:

- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL` یا معادل اتصال مناسب به Supabase
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`
- `ADMIN_TELEGRAM_ID`
- `ADMIN_IDS`
- `REQUIRED_CHANNEL`
- `WEBAPP_URL`

envهای غیراحساس:

- TTLها
- feature flags مهاجرت
- endpointهای خارجی

## نقشه اجزا

### Workerهای پیشنهادی

#### گزینه A: یک Worker اصلی

ساختار:

- `api-worker`
  - همه endpointها
  - webhook تلگرام
  - cache access
  - DB access

مزایا:

- ساده‌تر
- کم‌ریسک‌تر برای فاز اول
- حفظ راحت‌تر contractهای فعلی

معایب:

- یک codebase بزرگ‌تر

#### گزینه B: چند Worker تخصصی

نمونه:

- `api-core-worker`
- `telegram-webhook-worker`
- `scheduled-worker`

مزایا:

- جداسازی مسئولیت

معایب:

- deployment و routing پیچیده‌تر
- ریسک بیشتر در فاز ابتدایی

### تصمیم پیشنهادی

برای migration کم‌ریسک:

- در ابتدا **یک Worker اصلی** برای API + webhook
- یک Cron Trigger برای alerts
- Pages برای frontend

## مسیر مهاجرت پیشنهادی

### Step 1: مستندسازی و تثبیت contract

- مستندسازی endpointها
- مستندسازی DB schema
- مستندسازی وابستگی‌ها

### Step 2: ساخت shell معماری Cloudflare

- ایجاد ساختار Pages
- ایجاد Worker اصلی
- تعریف bindings و namespaces
- تعریف env و secrets

### Step 3: انتقال frontend به Pages

- بدون تغییر رفتار
- فقط تغییر host و API base
- هنوز امکان fallback به backend فعلی حفظ شود

### Step 4: انتقال endpointهای public و کم‌ریسک

اولویت:

- `/api/health`
- `/api/charts/resolve`
- `/api/calendar/events`
- `/api/farsi-news`
- `/api/analyses` GET

### Step 5: انتقال auth و user endpoints

اولویت:

- Telegram initData validation
- `/api/users/bootstrap`
- `/api/users/me`
- `/api/users/me/settings`
- `/api/watchlist`

### Step 6: انتقال mandatory join

اولویت:

- `/api/check-join`
- `/api/debug/check-join`
- `/api/check-join/invalidate`
- حفظ `users.channel_joined`
- انتقال join cache به KV

### Step 7: انتقال webhook و `/start`

اولویت:

- `POST /telegram`
- command `/start`
- ارسال پیام‌های bot
- تنظیم webhook روی Cloudflare Worker

### Step 8: انتقال AI و referral و session

اولویت:

- `/api/assistant/*`
- `/api/referrals/*`
- `/api/sessions/*`

### Step 9: انتقال tickets و alerts از file-based به DB-backed

اولویت:

- فعال‌سازی رسمی `tickets`, `ticket_replies`, `price_alerts`
- حذف وابستگی به فایل محلی
- انتقال polling alerts به Cron Trigger

### Step 10: حذف کامل Render

- حذف `onrender` از env و frontend
- غیرفعال کردن backend Render
- نهایی‌سازی production routing روی Cloudflare

## نگاشت اجزای فعلی به اجزای هدف

| جزء فعلی | وضعیت فعلی | جزء هدف |
|---|---|---|
| FastAPI runtime | روی Render | Cloudflare Worker |
| Telegram webhook | داخل FastAPI | Cloudflare Worker |
| Mini App static files | استقرار جداگانه | Cloudflare Pages |
| Redis cache | Redis/in-memory | Cloudflare KV |
| alerts polling loop | background loop | Cron Trigger |
| file-based tickets | `tickets.json` | Supabase DB |
| file-based alerts | `alerts.json` | Supabase DB |
| PostgreSQL | Supabase | Supabase |
| join status source | DB + cache | DB + KV |
| online presence | Redis | KV یا DO |

## ریسک‌های اجرایی در طرح Cloudflare

### ریسک 1

- بازنویسی backend بدون شکستن contract فعلی

راهکار:

- انتقال endpointها به‌صورت مرحله‌ای
- تست response shape قبل از cutover

### ریسک 2

- session presence در KV رفتار ۱۰۰٪ معادل Redis ندارد

راهکار:

- شروع با KV approximate
- در صورت نیاز واقعی، DO برای presence

### ریسک 3

- alerts و tickets فعلی file-based هستند

راهکار:

- قبل از حذف Render، storage پایدار آن‌ها را به Supabase منتقل کنید

### ریسک 4

- webhook bot نباید حتی لحظه‌ای بشکند

راهکار:

- استقرار Worker webhook قبل از حذف Render
- تست end-to-end قبل از switch نهایی

## تصمیم‌های معماری پیشنهادی

### تصمیم قطعی پیشنهادی

- Pages برای frontend
- یک Worker اصلی برای API و webhook
- KV برای cache
- Supabase برای source of truth
- Cron Trigger برای alerts

### تصمیم مشروط

- Durable Objects فقط اگر session presence دقیق لازم باشد

## تعریف موفقیت

معماری Cloudflare زمانی موفق است که:

- همه endpointهای فعلی بدون تغییر رفتاری کار کنند
- Mini App بدون وابستگی به Render اجرا شود
- Telegram Bot webhook روی Cloudflare پاسخ دهد
- join-check و `/start` بدون رگرسیون کار کنند
- cache به KV منتقل شده باشد
- state file-based حذف شده باشد
- Supabase schema اصلی حفظ شده باشد

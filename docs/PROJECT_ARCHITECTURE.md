# معماری فعلی پروژه

## نمای کلی

این پروژه یک Telegram Mini App با بک‌اند FastAPI، ربات تلگرام، دیتابیس PostgreSQL روی Supabase و لایه کش Redis است. در وضعیت فعلی:

- فرانت‌اند Mini App به‌صورت SPA با `index.html` و `app.js` پیاده‌سازی شده است.
- بک‌اند اصلی در `main.py` اجرا می‌شود.
- ربات تلگرام به‌صورت webhook-based داخل همان فرآیند FastAPI راه‌اندازی می‌شود.
- دیتابیس اصلی PostgreSQL است و از طریق `DATABASE_URL` به Supabase متصل می‌شود.
- کش فعلی با Redis پیاده‌سازی شده و در نبود Redis به حافظه process fallback می‌کند.
- یک Cloudflare Worker Shell در `worker-proxy.js` وجود دارد که بخشی از endpointها را مستقیم پاسخ می‌دهد و بقیه‌ی مسیرهای `/api/*` را به upstream (از طریق `BACKEND_URL`) proxy می‌کند.
- فایل‌های استاتیک Mini App قابلیت استقرار روی Cloudflare Pages را دارند (`webapp/pages-dist`).

## اجزای اصلی سیستم

### 1. Frontend / Telegram Mini App

فایل‌های اصلی:

- `index.html`
- `app.js`
- `style.css`
- `assistant.js`
- `notifications.js`
- `watchlist.js`

وظایف:

- بوت‌استرپ کاربر از Telegram WebApp
- ارسال `X-Telegram-Init-Data` به API
- مدیریت صفحات داخلی SPA
- نمایش وضعیت عضویت اجباری در کانال
- مدیریت واچ‌لیست، تیکت، هشدار، تحلیل، اخبار، پروفایل و پنل مدیریت

نکات مهم:

- `window.API_BASE` به‌صورت پیش‌فرض `window.location.origin` است و می‌تواند از بیرون override شود (بدون hardcode کردن host).
- Overlay عضویت اجباری با `#mandatory-join-overlay` در فرانت‌اند اعمال می‌شود.
- منطق `apiFetch` به آماده بودن `Telegram.WebApp` و `initData` وابسته است.

### 2. Backend / FastAPI

فایل ورودی اصلی:

- `main.py`

وظایف:

- ساخت و راه‌اندازی FastAPI
- mount کردن routerهای `backend/routers`
- راه‌اندازی Telegram Bot در webhook mode
- ثبت webhook تلگرام
- ارائه endpointهای API
- پیاده‌سازی مستقیم برخی قابلیت‌ها مانند:
  - `check-join`
  - `tickets`
  - `alerts`
  - `notify`
  - `farsi-news`
  - `telegram webhook`

### 3. Telegram Bot

وضعیت فعلی:

- ربات در `bot.py` مستقل اجرا نمی‌شود.
- اجرای واقعی ربات در `main.py` انجام می‌شود.
- `/start` داخل همان runtime بک‌اند هندل می‌شود.
- webhook تلگرام روی مسیر `/telegram` قرار دارد.

ویژگی‌ها:

- بررسی وضعیت عضویت کاربر
- ارسال پیام welcome یا دکمه عضویت
- باز کردن Mini App از طریق `web_app`
- ارسال اعلان برای تیکت‌ها و هشدارها

### 4. Supabase / PostgreSQL

نقش Supabase در معماری فعلی:

- منبع اصلی داده برای کاربران
- نگه‌داری واچ‌لیست
- نگه‌داری تحلیل‌ها
- نگه‌داری referral و tokenها
- نگه‌داری schema اصلی پروژه

نکته:

- اگرچه تیکت و هشدار مدل دیتابیسی دارند، APIهای فعال فعلی هنوز فایل‌محور هستند و از DB استفاده نمی‌کنند.

### 5. Redis / Cache Layer

فایل اصلی:

- `backend/redis_client.py`

مصارف فعلی:

- cache وضعیت عضویت کاربران
- session tracking و شمارش کاربران آنلاین
- cache اخبار
- cache تحلیل‌ها
- cache تقویم اقتصادی
- cache resolve چارت
- rate limit برای AI Assistant

fallback فعلی:

- اگر `REDIS_URL` تنظیم نشده باشد، پروژه از cache درون‌حافظه‌ای process استفاده می‌کند.

### 6. Cloudflare / Proxy Layer

فایل‌های موجود:

- `worker-proxy.js`
- `wrangler.jsonc`
- `wrangler.pages.jsonc`
- `wrangler.jsonc.bak`

وضعیت واقعی:

- `worker-proxy.js` یک shell مهاجرتی است: بخشی از مسیرها Worker-native هستند و مسیرهای باقی‌مانده به upstream proxy می‌شوند.
- پیکربندی Wrangler برای Worker و Pages در فایل‌های JSONC موجود است.

### 7. Node / Prisma Sidecar

فایل‌ها:

- `package.json`
- `lib/prisma.js`
- `lib/db-config.js`
- `prisma/schema.prisma`
- `test_db.js`

نقش فعلی:

- ابزار کمکی برای تست اتصال DB و استفاده از Prisma
- مسیر اصلی اجرای پروژه نیست
- اپلیکیشن production فعلی بر پایه Python/FastAPI است، نه Node

## ساختار پوشه‌ها

```text
.
├── assets/                      # فایل‌های استاتیک مانند لوگو
├── backend/
│   ├── routers/                 # endpointهای ماژولار FastAPI
│   ├── services/                # منطق دامنه و سرویس‌ها
│   ├── config.py                # تنظیمات محیطی
│   ├── database.py              # اتصال DB و session management
│   ├── models.py                # مدل‌های SQLAlchemy
│   └── redis_client.py          # لایه کش Redis + fallback
├── docs/                        # مستندات پروژه
├── lib/                         # ابزارهای کمکی Node/Prisma
├── prisma/                      # schema مربوط به Prisma
├── webapp/                      # پیکربندی‌های جانبی
├── app.js                       # هسته فرانت Mini App
├── assistant.js                 # ویجت چت AI
├── notifications.js             # اعلان‌ها
├── watchlist.js                 # helper واچ‌لیست
├── style.css                    # استایل‌ها
├── index.html                   # پوسته Mini App
├── main.py                      # entrypoint اصلی backend + bot
├── bot.py                       # runner غیرفعال bot
├── worker-proxy.js              # Cloudflare Worker Shell (Worker-native + proxy)
├── wrangler.jsonc               # پیکربندی Cloudflare Worker
├── wrangler.pages.jsonc         # پیکربندی Cloudflare Pages
├── env.example                  # env نمونه اصلی
└── requirements.txt             # وابستگی‌های Python
```

## ارتباط بین اجزا

### جریان کاربر Mini App

1. کاربر از تلگرام Mini App را باز می‌کند.
2. فرانت‌اند `Telegram.WebApp.initData` را دریافت می‌کند.
3. درخواست‌ها با هدر `X-Telegram-Init-Data` به `API_BASE` ارسال می‌شوند (Worker Shell یا upstream).
4. Worker Shell (یا backend) `initData` را validate می‌کند.
5. اطلاعات کاربر از Supabase/PostgreSQL خوانده یا ثبت می‌شود (مستقیم یا از طریق upstream).
6. وضعیت عضویت از KV/Redis/DB/Telegram API بررسی می‌شود.
7. UI بر اساس نتیجه join-check و داده‌های کاربر نمایش داده می‌شود.

### جریان ربات تلگرام

1. تلگرام رویداد را به webhook می‌فرستد.
2. webhook می‌تواند روی Worker (`/telegram`) یا روی backend (`main.py`) سرو شود (بسته به cutover).
3. در backend، `python-telegram-bot` همان رویداد را به handlerها پاس می‌دهد.
4. `/start` وضعیت عضویت را از DB بررسی می‌کند.
5. اگر عضو باشد، دکمه `web_app` می‌گیرد.
6. اگر عضو نباشد، لینک عضویت در کانال می‌گیرد.

### جریان جوین اجباری

1. فرانت‌اند `/api/check-join` را صدا می‌زند.
2. backend ابتدا cache را بررسی می‌کند.
3. در صورت نیاز، DB را بررسی می‌کند.
4. اگر لازم باشد، Telegram `getChatMember` را صدا می‌زند.
5. نتیجه در cache ذخیره می‌شود.
6. اگر عضویت تأیید شود، `users.channel_joined` در DB آپدیت می‌شود.

## Dependency Map

### وابستگی‌های لایه Frontend

- Telegram WebApp SDK
- API backend
- Telegram initData

### وابستگی‌های لایه Backend

- FastAPI
- SQLAlchemy
- PostgreSQL / Supabase
- Redis
- Telegram Bot API
- python-telegram-bot
- RSS و خبر خارجی
- CoinGecko
- ForexFactory
- سرویس‌های AI

### وابستگی‌های اصلی فایل‌ها

- `main.py`
  - `backend.config`
  - `backend.database`
  - `backend.redis_client`
  - `backend.routers.*`
  - `backend.services.join_service`
  - `backend.services.telegram_auth`
  - `backend.services.user_service`
  - `telegram`
  - `requests`

- `backend/routers/users.py`
  - `backend.database`
  - `backend.services.telegram_auth`
  - `backend.services.user_service`

- `backend/routers/watchlist.py`
  - `backend.database`
  - `backend.services.telegram_auth`
  - `backend.services.user_service`

- `backend/routers/analyses.py`
  - `backend.database`
  - `backend.services.analysis_service`
  - `backend.services.telegram_auth`

- `backend/routers/calendar.py`
  - `backend.services.calendar_service`

- `backend/routers/charts.py`
  - `backend.services.chart_service`

- `backend/routers/referrals.py`
  - `backend.database`
  - `backend.services.referral_service`
  - `backend.services.telegram_auth`

- `backend/routers/sessions.py`
  - `backend.services.session_service`
  - `backend.services.telegram_auth`

- `backend/routers/assistant.py`
  - `backend.services.ai_service`
  - `backend.services.telegram_auth`

## وابستگی بین Frontend، Backend، Bot، Supabase و Upstream/Cloudflare

### Frontend ↔ Backend

- تمام قابلیت‌های اصلی UI از طریق endpointهای `/api/*` به backend وصل هستند.
- CORS در backend باز است و auth اصلی بر پایه Telegram initData انجام می‌شود.

### Backend ↔ Supabase

- اتصال از طریق `DATABASE_URL` به PostgreSQL انجام می‌شود.
- مدل‌های SQLAlchemy schema اصلی را مدیریت می‌کنند.

### Backend/Worker ↔ Upstream hosting

- آدرس upstream برای مسیرهای proxy از طریق `BACKEND_URL` تعیین می‌شود و در repo hardcode نشده است.
- `TELEGRAM_WEBHOOK_URL` نیز env است و می‌تواند به Worker یا هر میزبان دیگری اشاره کند.

### Bot ↔ Backend

- Bot درون همان runtime بک‌اند اجرا می‌شود.
- webhook و command handlerها بخشی از `main.py` هستند.

### Frontend ↔ Bot

- فرانت مستقیماً با Bot حرف نمی‌زند.
- Bot فقط نقطه ورود کاربر به Mini App را فراهم می‌کند.

## جمع‌بندی معماری فعلی

- معماری فعلی کار می‌کند، اما چندمرکزی و نیمه‌مهاجرتی است.
- بخشی از مسیرها روی Worker-native اجرا می‌شوند و بخشی هنوز به upstream وابسته‌اند.
- Supabase منبع اصلی داده است.
- Cloudflare اکنون هم نقش Pages (برای استاتیک) و هم Worker Shell (برای بخشی از APIها) را دارد.
- state پروژه بین DB، Redis و فایل‌های JSON تقسیم شده است.
- برای تکمیل مهاجرت Cloudflare-native، باید وابستگی به upstream حذف شود و stateهای file-based به storage پایدار منتقل شوند، بدون شکستن contract فعلی APIها.

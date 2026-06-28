# شمای دیتابیس پروژه

## مقدمه

این سند بر اساس مدل‌های واقعی تعریف‌شده در `backend/models.py` تهیه شده است. دیتابیس اصلی پروژه PostgreSQL است که از طریق `DATABASE_URL` به Supabase متصل می‌شود.

نکته مهم:

- این سند شمای logical فعلی پروژه را نشان می‌دهد.
- برخی از جداول در runtime فعلی فعالانه استفاده می‌شوند.
- برخی دیگر در مدل‌ها تعریف شده‌اند اما endpointهای عملیاتی فعلی هنوز از نسخه file-based استفاده می‌کنند.

## منبع شمای فعلی

- ORM: SQLAlchemy
- فایل مرجع: `backend/models.py`
- موتور DB: PostgreSQL
- میزبان فعلی: Supabase

## جداول

### 1. `users`

نقش:

- جدول اصلی کاربران
- مبنای احراز هویت داخلی و وضعیت join
- مبنای watchlist، tickets، alerts، referrals و tokenها

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `telegram_id` | `String(64)` | خیر | کلید اصلی و شناسه کاربر تلگرام |
| `username` | `String(128)` | بله | نام کاربری تلگرام |
| `first_name` | `String(128)` | بله | نام |
| `last_name` | `String(128)` | بله | نام خانوادگی |
| `lang` | `String(8)` | خیر | زبان کاربر، پیش‌فرض `fa` |
| `channel_joined` | `Boolean` | خیر | وضعیت عضویت در کانال اجباری |
| `channel_verified_at` | `DateTime(timezone=True)` | بله | زمان آخرین تأیید عضویت |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |
| `updated_at` | `DateTime(timezone=True)` | خیر | زمان آخرین به‌روزرسانی |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `telegram_id`

#### روابط

- یک به چند با `watchlist_items`
- یک به چند با `tickets`
- یک به چند با `price_alerts`
- مرجع برای `referrals.inviter_id`
- مرجع برای `referrals.invitee_id`
- یک به یک منطقی با `token_balances`
- یک به چند با `token_transactions`

---

### 2. `watchlist_items`

نقش:

- نگه‌داری واچ‌لیست کاربران

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `Integer` | خیر | کلید اصلی auto increment |
| `user_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `symbol` | `String(32)` | خیر | نماد کوین |
| `position` | `Integer` | خیر | ترتیب نمایش |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Key:
  - `user_id -> users.telegram_id`
- Unique Constraint:
  - `uq_watchlist_user_symbol` روی `(user_id, symbol)`
- Index:
  - `user_id`

#### روابط

- چند به یک با `users`

---

### 3. `analyses`

نقش:

- ذخیره تحلیل‌های منتشرشده در پنل و Mini App

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `String(64)` | خیر | کلید اصلی |
| `coin` | `String(32)` | خیر | نام یا نماد کوین |
| `timeframe` | `String(16)` | خیر | بازه زمانی تحلیل |
| `image` | `String(512)` | بله | تصویر تحلیل |
| `text` | `Text` | خیر | متن تحلیل |
| `author` | `String(128)` | خیر | نام نویسنده |
| `author_id` | `String(64)` | بله | شناسه ادمین نویسنده |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |
| `updated_at` | `DateTime(timezone=True)` | خیر | زمان ویرایش |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Index:
  - `coin`

#### روابط

- رابطه FK صریح تعریف نشده، اما `author_id` به‌صورت منطقی به ادمین تلگرام اشاره دارد.

---

### 4. `tickets`

نقش:

- مدل دیتابیسی تیکت‌ها

وضعیت استفاده:

- در مدل‌ها وجود دارد.
- یک service دیتابیسی هم برای آن موجود است.
- اما endpointهای عملیاتی فعلی هنوز از `data/tickets.json` استفاده می‌کنند.

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `String(64)` | خیر | کلید اصلی |
| `user_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `user_name` | `String(128)` | خیر | نام نمایشی کاربر |
| `title` | `String(256)` | خیر | عنوان تیکت |
| `body` | `Text` | خیر | متن اصلی تیکت |
| `status` | `String(32)` | خیر | وضعیت تیکت |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |
| `updated_at` | `DateTime(timezone=True)` | خیر | زمان آخرین تغییر |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Key:
  - `user_id -> users.telegram_id`
- Index:
  - `user_id`
  - `status`
  - `created_at`

#### روابط

- چند به یک با `users`
- یک به چند با `ticket_replies`

---

### 5. `ticket_replies`

نقش:

- نگه‌داری replyهای تیکت

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `Integer` | خیر | کلید اصلی auto increment |
| `ticket_id` | `String(64)` | خیر | FK به `tickets.id` |
| `sender_type` | `String(16)` | خیر | `user` یا `admin` |
| `sender_id` | `String(64)` | بله | شناسه فرستنده |
| `message` | `Text` | خیر | متن پاسخ |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Key:
  - `ticket_id -> tickets.id`
- Index:
  - `ticket_id`
  - `sender_id`
  - `created_at`

#### روابط

- چند به یک با `tickets`

---

### 6. `price_alerts`

نقش:

- مدل دیتابیسی هشدار قیمت

وضعیت استفاده:

- در مدل‌ها تعریف شده است.
- اما endpointهای عملیاتی فعلی هنوز از فایل `data/alerts.json` استفاده می‌کنند.

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `String(64)` | خیر | کلید اصلی |
| `user_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `symbol` | `String(32)` | خیر | نماد |
| `price` | `Float` | خیر | قیمت هدف |
| `direction` | `String(16)` | خیر | `above` یا `below` |
| `status` | `String(16)` | خیر | وضعیت هشدار |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |
| `triggered_at` | `DateTime(timezone=True)` | بله | زمان trigger |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Key:
  - `user_id -> users.telegram_id`
- Unique Constraint:
  - `uq_price_alert_user_symbol_price_direction`
  - روی `(user_id, symbol, price, direction)`
- Index:
  - `user_id`
  - `symbol`
  - `status`
  - `created_at`

#### روابط

- چند به یک با `users`

---

### 7. `referrals`

نقش:

- نگه‌داری ارتباط دعوت‌کننده و دعوت‌شونده
- کنترل channel verification و reward

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `Integer` | خیر | کلید اصلی auto increment |
| `inviter_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `invitee_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `channel_verified` | `Boolean` | خیر | آیا عضویت کانال برای invitee تأیید شده است |
| `rewarded` | `Boolean` | خیر | آیا پاداش داده شده است |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ایجاد |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Keys:
  - `inviter_id -> users.telegram_id`
  - `invitee_id -> users.telegram_id`
- Unique Constraint:
  - `uq_referral_invitee` روی `invitee_id`
- Index:
  - `inviter_id`

#### روابط

- دو FK به جدول `users`

---

### 8. `token_balances`

نقش:

- نگه‌داری موجودی توکن داخلی هر کاربر

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `user_id` | `String(64)` | خیر | PK و FK به `users.telegram_id` |
| `balance` | `Integer` | خیر | موجودی کاربر |
| `updated_at` | `DateTime(timezone=True)` | خیر | زمان آخرین به‌روزرسانی |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `user_id`
- Foreign Key:
  - `user_id -> users.telegram_id`

#### روابط

- یک به یک منطقی با `users`

---

### 9. `token_transactions`

نقش:

- ثبت تاریخچه تراکنش‌های توکن

#### ستون‌ها

| ستون | نوع | Nullable | توضیح |
|---|---|---|---|
| `id` | `Integer` | خیر | کلید اصلی auto increment |
| `user_id` | `String(64)` | خیر | FK به `users.telegram_id` |
| `amount` | `Integer` | خیر | مقدار تغییر |
| `tx_type` | `String(32)` | خیر | نوع تراکنش |
| `description` | `String(256)` | بله | توضیح |
| `ref_id` | `String(64)` | بله | شناسه مرجع |
| `created_at` | `DateTime(timezone=True)` | خیر | زمان ثبت |

#### کلیدها و ایندکس‌ها

- Primary Key:
  - `id`
- Foreign Key:
  - `user_id -> users.telegram_id`
- Index:
  - `user_id`

#### روابط

- چند به یک با `users`

---

## روابط بین جداول

```text
users
├── watchlist_items (1:N)
├── tickets (1:N)
│   └── ticket_replies (1:N)
├── price_alerts (1:N)
├── token_transactions (1:N)
├── token_balances (1:1 منطقی)
└── referrals
    ├── inviter_id -> users.telegram_id
    └── invitee_id -> users.telegram_id
```

## جداول فعال در runtime فعلی

### فعال و استفاده‌شده در APIهای فعلی

- `users`
- `watchlist_items`
- `analyses`
- `referrals`
- `token_balances`
- `token_transactions`

### تعریف‌شده ولی هنوز fully wired نیستند

- `tickets`
- `ticket_replies`
- `price_alerts`

## محدودیت‌ها و نکات مهم

### 1. منبع حقیقت عضویت کانال

فیلد:

- `users.channel_joined`

این فیلد برای:

- کنترل دسترسی در `/start`
- کنترل join gate در Mini App
- referral verification

استفاده می‌شود.

### 2. وضعیت فعلی تیکت و هشدار

اگرچه جداول دیتابیسی موجود هستند:

- API فعال تیکت‌ها از فایل `data/tickets.json` استفاده می‌کند.
- API فعال هشدارها از فایل `data/alerts.json` استفاده می‌کند.

بنابراین در مهاجرت Cloudflare:

- این دو بخش باید به storage پایدار منتقل شوند.
- بهترین گزینه فعلی، فعال‌سازی کامل DB-backed flow با همین schema موجود است.

### 3. ایندکس‌های ضمنی

علاوه بر constraints صریح، SQLAlchemy برای ستون‌هایی که `index=True` دارند ایندکس می‌سازد، از جمله:

- `watchlist_items.user_id`
- `analyses.coin`
- `tickets.user_id`
- `tickets.status`
- `tickets.created_at`
- `ticket_replies.ticket_id`
- `ticket_replies.sender_id`
- `ticket_replies.created_at`
- `price_alerts.user_id`
- `price_alerts.symbol`
- `price_alerts.status`
- `price_alerts.created_at`
- `referrals.inviter_id`
- `token_transactions.user_id`

## جمع‌بندی

- دیتابیس اصلی پروژه از قبل برای بخش زیادی از قابلیت‌ها آماده است.
- schema موجود برای کاربران، تحلیل‌ها، referral و tokenها مناسب و فعال است.
- schema لازم برای tickets و alerts هم از قبل وجود دارد و می‌تواند مبنای مهاجرت بدون تغییرات بزرگ باشد.
- برای مهاجرت به Cloudflare + Supabase، حفظ همین schema بهترین گزینه کم‌ریسک است.

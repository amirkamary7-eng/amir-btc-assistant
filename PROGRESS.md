# وضعیت پیشرفت پیاده‌سازی

مبنای کار فقط فایل‌های داخل `docs/` است.

## فازها

- Phase 0 / شناخت و تحلیل ✔
- Phase 1 / مستندسازی ✔
- Phase 2 / طراحی مهاجرت مرحله‌ای ⏳
- Phase 3 / آماده‌سازی زیرساخت Cloudflare ⏳
- Phase 4 / انتقال APIها ⏳
- Phase 5 / انتقال webhook ربات ✔
- Phase 6 / انتقال cache ⏳
- Phase 7 / انتقال stateهای فایل‌محور ⏳
- Phase 8 / حذف کامل Render ⏳

## بخش‌های اجرایی

- Cloudflare shell baseline ✔
- Worker routing برای `/api/*` و `/telegram` ✔
- `GET /api/health` روی Worker ✔
- Wrangler JSONC config ✔
- Cloudflare scripts در `package.json` ✔
- Worker env baseline در `env.example` ✔
- Wrangler dry-run validation ✔
- Pages setup ✔
- KV namespace bindingها ✔
- Cron jobs baseline ✔
- Scheduled alerts execution ✔
- Public API migration ✔
- `GET /api/charts/resolve` روی Worker ✔
- `GET /api/calendar/events` روی Worker ✔
- `GET /api/farsi-news` روی Worker ✔
- `GET /api/analyses` روی Worker ✔
- Auth و user flow migration ✔
  - Telegram initData validation روی Worker ✔
  - `POST /api/users/bootstrap` روی Worker (proxy-safe + auth validation) ✔
  - `GET /api/users/me` روی Worker (auth validation) ✔
  - `PUT /api/users/me/settings` روی Worker ✔
  - `/api/watchlist` روی Worker ✔
- Mandatory join migration ✔
- Webhook و `/start` migration ✔
- Cache migration ⏳
- Tickets migration ⏳
- Alerts migration ⏳
- Render removal ⏳

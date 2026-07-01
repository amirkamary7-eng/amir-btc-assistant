# وضعیت پیشرفت پیاده‌سازی

Source of Truth: این فایل (`PROGRESS.md`) + وضعیت واقعی کد داخل مخزن. خلاصه رسمی و یکپارچه در `PROJECT_STATUS.md` نگه‌داری می‌شود.

## فازها

- Phase 0 / شناخت و تحلیل: done
- Phase 1 / مستندسازی: done
- Phase 2 / طراحی مهاجرت مرحله‌ای: partial
- Phase 3 / آماده‌سازی زیرساخت Cloudflare: partial
- Phase 4 / انتقال APIها: partial
- Phase 5 / انتقال webhook ربات: partial
- Phase 6 / انتقال cache: partial
- Phase 7 / انتقال stateهای فایل‌محور: not started
- Phase 8 / حذف کامل Render: partial

## بخش‌های اجرایی

- Cloudflare Worker shell baseline: done
- Worker routing برای `/api/*` و `/telegram`: done
- `GET /api/health` روی Worker: done
- Wrangler JSONC config (`wrangler.jsonc`, `wrangler.pages.jsonc`): done
- Cloudflare scripts در `package.json`: done
- Worker env baseline در `env.example`: done
- Pages setup (خروجی `webapp/pages-dist`): done
- KV namespace bindingها: done
- Cron jobs baseline: done
- Scheduled alerts execution: partial
- Public API migration (Worker-native): partial
  - `GET /api/charts/resolve`: done
  - `GET /api/calendar/events`: done
  - `GET /api/farsi-news`: done
  - `GET /api/analyses` (با cache و fallback به upstream): partial
- Auth و user flow migration: partial
  - Telegram initData validation روی Worker: done
  - `POST /api/users/bootstrap`: partial (proxy-safe + auth validation)
  - `GET /api/users/me`: partial (auth validation + proxy)
  - `PUT /api/users/me/settings`: partial (auth validation + proxy)
  - `/api/watchlist` GET/PUT: partial (auth validation + proxy)
- Mandatory join migration (`/api/check-join*`): done
- Webhook و `/start` migration (`POST /telegram`): partial
- Cache migration: partial
  - JOIN_CACHE / APP_CACHE / RATE_LIMITS / SESSION_CACHE برای مسیرهای Worker-native: done
  - حذف Redis از کل سیستم: not started
- Tickets migration: partial (Worker proxy-safe + upstream file-based)
- Alerts migration: partial (Worker proxy-safe + upstream file-based + baseline cron hook)
- Render removal: partial (عدم hardcode در repo؛ ولی هنوز upstream از طریق `BACKEND_URL` لازم است)

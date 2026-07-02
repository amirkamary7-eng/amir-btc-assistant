<<<<<<< HEAD
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
- Cache migration ✔
- Tickets migration ✔
- Alerts migration ✔
- Render removal ✔
=======
# Project Progress

> **محاسبه فقط از `TASK_BOARD.md`** — این فایل را دستی ویرایش نکنید؛ پس از تغییر وضعیت تسک‌ها در `TASK_BOARD.md`، بخش Progress در همان فایل مرجع است.

## Source of Truth

| فایل | نقش |
|------|-----|
| `گزارش 3.txt` | تعریف backlog (Phase، Task، فیلدها، dependency) |
| `TASK_BOARD.md` | وضعیت زنده تسک‌ها + ترتیب اجرا |
| `PROGRESS.md` | خلاصه progress (این فایل) |

## Snapshot — 2026-07-02

| Metric | Value |
|--------|-------|
| Total tasks | 54 |
| ✅ Done | 0 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 54 |
| **Progress** | **0%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 0 | 0% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 0 | 0% |
| 4 | Security Hardening | 13 | 0 | 0% |
| 5 | Optimization & Cleanup | 12 | 0 | 0% |

## Current Phase

**Phase 1: Critical Stability** — هیچ تسکی شروع نشده.

## Next Executable Tasks (no open dependencies)

این تسک‌ها می‌توانند توسط Agent شروع شوند (همه وابستگی‌ها یا None هستند یا به تسک‌های Done وابسته‌اند — فعلاً همه Todo):

| Task ID | Title | Priority |
|---------|-------|----------|
| 1.0 | ثبت وضعیت live deployment (manual checklist) | Critical |
| 1.1 | Fix Worker Telegram HMAC | Critical |
| 1.4 | Separate KV namespace IDs | Critical |
| 1.5 | Inject API_BASE at Pages build time | Critical |
| 3.3 | Admin join bypass — use full admin set | Medium |
| 3.4 | Global error handler — return 5xx not 200 | Medium |
| 3.5 | Generic DB error responses on Worker | Medium |
| 3.7 | Delete unused ticket_service.py | Low |
| 4.2 | AI history sanitization — FastAPI | High |
| 4.6 | Gemini API key — header not URL | High |
| 4.10 | Referrer validation | Medium |
| 4.12 | Sanitize env.example | Medium |
| 5.1 | Remove mock news fallback | Low |
| 5.2 | Remove unused config keys — Python | Low |
| 5.3 | Remove unused wrangler vars | Low |
| 5.8 | Alembic migrations baseline | Medium |
| 5.11 | Remove dead imports/code in main.py | Low |

## Agent Rules (summary)

1. فقط **یک Task** در هر session اجرا کن.
2. قبل از شروع، **Dependencies** را در `TASK_BOARD.md` بررسی کن — همه باید ✅ Done باشند.
3. وضعیت را به 🟨 In Progress تغییر بده، سپس پیاده‌سازی کن.
4. پس از برآورده شدن **Acceptance Criteria** → ✅ Done.
5. اگر dependency باز مانده → ⛔ Blocked و Task دیگری انتخاب نکن مگر از لیست «Next Executable».

جزئیات کامل: `TASK_BOARD.md` → بخش Agent Execution Rules.
>>>>>>> 8f7b43d (feat(task-1.1): implement <Task Name>)

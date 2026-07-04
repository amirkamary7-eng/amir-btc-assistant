# Project Progress

> **محاسبه فقط از `TASK_BOARD.md`** — این فایل را دستی ویرایش نکنید؛ پس از تغییر وضعیت تسک‌ها در `TASK_BOARD.md`، بخش Progress در همان فایل مرجع است.

## Source of Truth

| فایل | نقش |
|------|-----|
| `گزارش 3.txt` | تعریف backlog (Phase، Task، فیلدها، dependency) |
| `TASK_BOARD.md` | وضعیت زنده تسک‌ها + ترتیب اجرا |
| `PROGRESS.md` | خلاصه progress (این فایل) |

## Snapshot — 2026-07-03

| Metric | Value |
|--------|-------|
| Total tasks | 54 |
| ✅ Done | 21 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 33 |
| **Progress** | **39%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 7 | 100% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 5 | 63% |
| 4 | Security Hardening | 13 | 4 | 31% |
| 5 | Optimization & Cleanup | 12 | 5 | 42% |

## Current Phase

**Phase 3: Architecture Cleanup** — تسک‌های 3.3، 3.4، 3.5، 3.6 و 3.8 ✅ Done شده‌اند و این فاز به ۶۳٪ رسیده است.

## Recently Completed

| Task ID | Title |
|---------|-------|
| 1.0 | ثبت وضعیت live deployment (manual checklist) |
| 1.1 | Fix Worker Telegram HMAC — raw URL-encoded values in dataCheckString |
| 1.2 | Fix buildInitData test helper — align با Telegram spec |
| 1.3 | Wire `npm test` to worker test suite |
| 1.4 | Separate KV namespace IDs — staging vs production |
| 1.5 | Inject API_BASE at Pages build time |
| 1.6 | Runbook — single webhook target |
| 3.3 | Admin join bypass — full admin set |
| 3.4 | Global error handler — 5xx not 200 |
| 3.5 | Generic DB error responses on Worker |
| 3.6 | Remove unused Worker functions |
| 3.8 | Remove bot.py disabled stub |
| 4.10 | Referrer validation |
| 4.12 | Sanitize env.example |
| 4.2 | AI history sanitization — FastAPI |
| 4.6 | Gemini API key — header not URL |
| 5.3 | Remove unused wrangler vars |
| 5.1 | Remove mock news fallback |
| 5.8 | Alembic migrations baseline |
| 5.11 | Remove dead imports in main.py |

## Next Executable Tasks (no open dependencies)

| Task ID | Title | Priority |
|---------|-------|----------|
| 5.12 | Update index.html outdated comment | Low |

## Agent Rules (summary)

1. فقط **یک Task** در هر session اجرا کن.
2. قبل از شروع، **Dependencies** را در `TASK_BOARD.md` بررسی کن — همه باید ✅ Done باشند.
3. وضعیت را به 🟨 In Progress تغییر بده، سپس پیاده‌سازی کن.
4. پس از برآورده شدن **Acceptance Criteria** → ✅ Done.
5. اگر dependency باز مانده → ⛔ Blocked و Task دیگری انتخاب نکن مگر از لیست «Next Executable».

جزئیات کامل: `TASK_BOARD.md` → بخش Agent Execution Rules.

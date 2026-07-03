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
| ✅ Done | 7 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 47 |
| **Progress** | **13%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 7 | 100% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 0 | 0% |
| 4 | Security Hardening | 13 | 0 | 0% |
| 5 | Optimization & Cleanup | 12 | 0 | 0% |

## Current Phase

**Phase 1: Critical Stability** — Tasks 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 ✅ Done.

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

## Next Executable Tasks (no open dependencies)

| Task ID | Title | Priority |
|---------|-------|----------|
| 3.3 | Admin join bypass — use full admin set | Medium |
| 3.4 | Global error handler — return 5xx not 200 | Medium |
| 3.5 | Generic DB error responses on Worker | Medium |
| 3.6 | Remove unused Worker functions | Low |
| 3.7 | Delete unused ticket_service.py | Low |
| 3.8 | Remove bot.py disabled stub | Low |
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

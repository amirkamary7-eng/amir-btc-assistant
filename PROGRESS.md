# Project Progress

> **محاسبه فقط از `TASK_BOARD.md`** — این فایل را دستی ویرایش نکنید؛ پس از تغییر وضعیت تسک‌ها در `TASK_BOARD.md`، بخش Progress در همان فایل مرجع است.

## Source of Truth

| فایل | نقش |
|------|-----|
| `گزارش 3.txt` | تعریف backlog (Phase، Task، فیلدها، dependency) |
| `TASK_BOARD.md` | وضعیت زنده تسک‌ها + ترتیب اجرا |
| `PROGRESS.md` | خلاصه progress (این فایل) |

## Snapshot — 2026-07-04

| Metric | Value |
|--------|-------|
| Total tasks | 54 |
| ✅ Done | 15 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 39 |
| **Progress** | **28%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 6 | 86% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 2 | 25% |
| 4 | Security Hardening | 13 | 1 | 8% |
| 5 | Optimization & Cleanup | 12 | 6 | 50% |

## Current Phase

**Phase 1: Critical Stability** — فقط 1.1 باقی‌مانده (0% فعلی). تمام تسک‌های Phase 2 بازگشت داده شدند و نیاز به runtime verification دارند.

## DONE Criteria (قانون تأیید تسک)

🟢 **Category 1 — غیررفتاری** (Config/Cleanup/Refactor):
تغییر واقعی در codebase + بدون regression + تست‌ها (اگر هستند) pass

🔵 **Category 2 — رفتاری** (Feature/Logic/System Flow):
حداقل یکی: integration test واقعی (نه mock) / execution evidence (log/runtime/response) / E2E flow
unit test به تنهایی کافی نیست

🟡 **Category 3 — Ambiguous**: conservative → OPEN بماند

## ✅ Done (15 tasks)

| Task ID | Title | Category | Evidence |
|---------|-------|----------|----------|
| 1.0 | ثبت وضعیت live deployment | 🟢 1 | Doc — file exists with 5 items |
| 1.2 | Fix buildInitData test helper | 🟢 1 | Test refactor — npm test 52/52 |
| 1.3 | Wire npm test | 🟢 1 | Config — npm test exits 0 |
| 1.4 | Separate KV namespace IDs | 🟢 1 | Config — IDs separated + npm test pass |
| 1.5 | Inject API_BASE at Pages build | 🟢 1 | Build — `cf:pages:prepare` executed, output verified |
| 1.6 | Runbook — single webhook target | 🟢 1 | Doc — file content verified |
| 3.6 | Remove unused Worker functions | 🟢 1 | Cleanup — grep 0 match + npm test 52/52 |
| 3.8 | Remove bot.py disabled stub | 🟢 1 | File deletion — file doesn't exist |
| 4.12 | Sanitize env.example | 🟢 1 | File content — no secrets |
| 5.1 | Remove mock news fallback | 🟢 1 | Cleanup — grep 0 match |
| 5.2 | Remove unused config keys — Python | 🟢 1 | Cleanup — all keys verified used |
| 5.3 | Remove unused wrangler vars | 🟢 1 | Cleanup — all vars verified used |
| 5.8 | Alembic migrations baseline | 🔵 2 | `alembic upgrade head` executed, 9 tables created |
| 5.11 | Remove dead imports in main.py | 🟢 1 | Cleanup — all imports verified used |
| 5.12 | Update index.html outdated comment | 🟢 1 | File content — comment accurate |

## ⬜ Open — Category 2 (needs runtime verification)

| Task ID | Title | Needs |
|---------|-------|-------|
| 1.1 | Fix Worker Telegram HMAC | Real initData E2E |
| 2.1 | Analyses GET — read from PostgreSQL | Integration test with real DB |
| 2.2 | Analyses admin POST/PUT/DELETE | Integration test with real DB + auth |
| 2.3 | Analyses KV cache invalidation | Integration test with real DB + KV |
| 2.4 | Port price alert checker to Worker | Integration test with real APIs + DB |
| 2.5 | Wire alert runner into scheduled() | Real cron execution evidence |
| 2.6 | AI chat — provider fetch helpers | Real AI API call |
| 2.7 | AI chat — port prompt assembly | Integration test |
| 2.8 | AI chat — safe response parsing | Integration test |
| 2.9 | Replace assistant 501 with live AI | Real AI API response |
| 2.10 | Call recordRateLimitUsage after chat | Real KV increment evidence |
| 3.3 | Admin join bypass — full admin set | Integration test (Python unit test only) |
| 3.4 | Global error handler — 5xx not 200 | Integration test (mocked unit test only) |
| 3.5 | Generic DB error responses | Integration test (mocked unit test only) |
| 4.2 | AI history sanitization — FastAPI | Integration test (Python unit test only) |
| 4.6 | Gemini API key — header not URL | Real HTTP request evidence |
| 4.10 | Referrer validation | Integration test (mocked unit test only) |

## Next Executable Tasks (no open dependencies)

| Task ID | Phase | Title | Priority |
|---------|-------|-------|----------|
| 1.1 | 1 | Fix Worker Telegram HMAC | Critical |
| 2.11 | 2 | Webhook secret validation — Worker | High |
| 3.3 | 3 | Admin join bypass — full admin set | Medium |
| 3.4 | 3 | Global error handler — 5xx not 200 | Medium |
| 3.5 | 3 | Generic DB error responses | Medium |
| 3.7 | 3 | Delete unused ticket_service.py | Low |
| 4.2 | 4 | AI history sanitization — FastAPI | High |
| 4.6 | 4 | Gemini API key — header not URL | High |
| 4.7 | 4 | Restrict CORS to WEBAPP_URL | Medium |
| 4.10 | 4 | Referrer validation | Medium |

## Agent Rules (summary)

1. فقط **یک Task** در هر session اجرا کن.
2. قبل از شروع، **Dependencies** را در `TASK_BOARD.md` بررسی کن — همه باید ✅ Done باشند.
3. وضعیت را به 🟨 In Progress تغییر بده، سپس پیاده‌سازی کن.
4. پس از برآورده شدن **Acceptance Criteria** → ✅ Done.
5. اگر dependency باز مانده → ⛔ Blocked و Task دیگری انتخاب نکن مگر از لیست «Next Executable».

جزئیات کامل: `TASK_BOARD.md` → بخش Agent Execution Rules.
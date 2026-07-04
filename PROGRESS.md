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
| ✅ Done | 13 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 41 |
| **Progress** | **24%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 5 | 71% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 1 | 13% |
| 4 | Security Hardening | 13 | 1 | 8% |
| 5 | Optimization & Cleanup | 12 | 6 | 50% |

## Current Phase

**Phase 1: Critical Stability** — تسک‌های 1.0، 1.2، 1.3، 1.5 و 1.6 ✅ Done هستند. 1.1 و 1.4 نیاز به runtime verification دارند.

## Audit Note — 2026-07-04

19 تسک از ✅ به ⬜ بازگشت داده شدند. دلیل: تأیید فقط با code review و unit test (با mock) بود. معیار جدید: فقط runtime واقعی / integration test / evidence از اجرا.

## ✅ Done (runtime-verified)

| Task ID | Title | Evidence |
|---------|-------|----------|
| 1.0 | ثبت وضعیت live deployment | Doc task — AC = file existence |
| 1.2 | Fix buildInitData test helper | AC = unit tests pass (by definition) |
| 1.3 | Wire npm test | AC = npm test exits 0 (52 pass) |
| 1.5 | Inject API_BASE at Pages build | `cf:pages:prepare` executed twice, output verified |
| 1.6 | Runbook — single webhook target | Doc task — AC = file content |
| 3.8 | Remove bot.py disabled stub | File deleted — AC = file doesn't exist |
| 4.12 | Sanitize env.example | File content — AC = no secrets |
| 5.1 | Remove mock news fallback | Static — AC = no mock news in code |
| 5.2 | Remove unused config keys — Python | Static — AC = no unused keys |
| 5.3 | Remove unused wrangler vars | Static — AC = no unused vars |
| 5.8 | Alembic migrations baseline | `alembic upgrade head` executed, 9 tables created |
| 5.11 | Remove dead imports in main.py | Static — AC = no unused imports |
| 5.12 | Update index.html outdated comment | File content — AC = comment accurate |

## ⬜ Reopened (needs runtime verification)

| Task ID | Title | Reason |
|---------|-------|--------|
| 1.1 | Fix Worker Telegram HMAC | Only mocked unit test; needs real initData E2E |
| 1.4 | Separate KV namespace IDs | Config change; `wrangler dry-run` failed (pg import issue) |
| 2.1 | Analyses GET — read from PostgreSQL | Only mocked unit test; needs real DB |
| 2.2 | Analyses admin POST/PUT/DELETE | Only mocked unit test; needs real DB + auth |
| 2.3 | Analyses KV cache invalidation | Only mocked unit test; needs real DB + KV |
| 2.4 | Port price alert checker to Worker | Only mocked unit test; needs real APIs + DB |
| 2.5 | Wire alert runner into scheduled() | Only mocked unit test; needs real cron |
| 2.6 | AI chat — provider fetch helpers | Only mocked unit test; needs real AI APIs |
| 2.7 | AI chat — port prompt assembly | Only mocked unit test |
| 2.8 | AI chat — safe response parsing | Only mocked unit test |
| 2.9 | Replace assistant 501 with live AI | Only mocked unit test; needs real AI API call |
| 2.10 | Call recordRateLimitUsage after chat | Only mocked unit test; needs real KV |
| 3.3 | Admin join bypass — full admin set | Python unit test only |
| 3.4 | Global error handler — 5xx not 200 | Only mocked unit test |
| 3.5 | Generic DB error responses | Only mocked unit test |
| 3.6 | Remove unused Worker functions | Grep + mocked unit test only |
| 4.2 | AI history sanitization — FastAPI | Python unit test only |
| 4.6 | Gemini API key — header not URL | Code review only |
| 4.10 | Referrer validation | Only mocked unit test |

## Next Executable Tasks (no open dependencies)

| Task ID | Phase | Title | Priority |
|---------|-------|-------|----------|
| 1.1 | 1 | Fix Worker Telegram HMAC | Critical |
| 1.4 | 1 | Separate KV namespace IDs | Critical |
| 2.11 | 2 | Webhook secret validation — Worker | High |
| 3.3 | 3 | Admin join bypass — full admin set | Medium |
| 3.4 | 3 | Global error handler — 5xx not 200 | Medium |
| 3.5 | 3 | Generic DB error responses | Medium |
| 3.6 | 3 | Remove unused Worker functions | Low |
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
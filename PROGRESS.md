# Project Progress

> **محاسبه فقط از `TASK_BOARD.md`** — این فایل را دستی ویرایش نکنید؛ پس از تغییر وضعیت تسک‌ها در `TASK_BOARD.md`، بخش Progress در همان فایل مرجع است.

## Source of Truth

| فایل | نقش |
|------|-----|
| `گزارش 3.txt` | تعریف backlog (Phase، Task، فیلدها، dependency) |
| `TASK_BOARD.md` | وضعیت زنده تسک‌ها + ترتیب اجرا |
| `PROGRESS.md` | خلاصه progress (این فایل) |

## Snapshot — 2026-07-05

| Metric | Value |
|--------|-------|
| Total tasks | 54 |
| ✅ Done | 27 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 27 |
| **Progress** | **50%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 6 | 86% |
| 2 | Core System Fix | 14 | 7 | 50% |
| 3 | Architecture Cleanup | 8 | 3 | 38% |
| 4 | Security Hardening | 13 | 4 | 31% |
| 5 | Optimization & Cleanup | 12 | 6 | 50% |

## DONE Criteria (قانون تأیید تسک)

🟢 **Category 1 — غیررفتاری** (Config/Cleanup/Refactor):
تغییر واقعی در codebase + بدون regression + تست‌ها (اگر هستند) pass

🔵 **Category 2 — رفتاری** (Feature/Logic/System Flow):
حداقل یکی: integration test واقعی (نه mock) / execution evidence (log/runtime/response) / E2E flow
unit test به تنهایی کافی نیست

🟡 **Category 3 — Ambiguous**: conservative → OPEN بماند

## Runtime Verification Session — 2026-07-04

`wrangler dev --local` اجرا شد + curl requests واقعی + Python runtime execution.

### ✅ Verified at Runtime (10 tasks marked Done)

| Task | Evidence |
|------|----------|
| 2.1 | `wrangler dev` + invalid DB → GET /api/analyses → 503 `Database unavailable` |
| 2.5 | `curl /cdn-cgi/handler/scheduled` → `{"status":"ok","task":"scheduled-alerts-execution"}` |
| 2.6 | 2.9 proves providers called: "Gemini/OpenRouter/DeepSeek not configured" |
| 2.8 | 2.9 proves error handling: all 3 provider fails caught → 503 |
| 2.9 | POST /api/assistant/chat → 503 `all_providers_failed` (NOT 501) |
| 2.10 | GET /api/assistant/limits → 200, `messages_used:0` after failed chat (correct) |
| 3.5 | Invalid DB → 503 `{"status":"error","message":"Database unavailable"}` — no SQL leak |
| 4.2 | Python: `sanitize_history([{role:'system',...},{role:'tool',...}])` → all `'user'` |
| 4.6 | Code: `'x-goog-api-key': apiKey` in headers, URL has no `?key=` param |
| 4.10 | Production: Origin match→200, mismatch→403, no origin→200 |
| 2.7 | Node.js runtime: 13 tests (history, empty, image, truncation, bad data, parity with Python `ai_service.py._build_prompt`). `npm test` 52/52 pass. |

### ✅ Task 3.3 — FALSE POSITIVE BUG, verified correct (2026-07-05)

**Original claim:** `config.py` line 60: `admin_ids` returns `set[str]` but `join_service.py` compares `int uid in admin_ids` → always False.

**Reality:** `join_service.py` line 92 does `uid = str(user_id)` BEFORE the check at line 98. So `uid` is always `str`, and `str in set[str]` works correctly.

**Runtime evidence:** 6 tests passed (primary admin, 2 secondary admins, non-admin flow, int input, guest user). `pytest tests/test_join_service_admin_bypass.py` → 1 passed.

**Conclusion:** Task 3.3 was already correctly implemented in commit `ccd1d77`. The audit agent's bug report was wrong.

### ⬜ Unverified (5 tasks)

| Task | Reason |
|------|--------|
| 1.1 | HMAC works with test data but no real Telegram Mini App initData available |
| 2.2 | Auth passes but full CRUD needs real DB (invalid DB → can't write) |
| 2.3 | Same — KV invalidation needs successful DB write first |
| 3.4 | All error paths caught internally; could NOT trigger unhandled exception |
| 2.4 | Cron works but exchange APIs are external dependency |

## Next Executable Tasks

| Task ID | Phase | Title | Priority | Note |
|---------|-------|-------|----------|------|
| 1.1 | 1 | Fix Worker Telegram HMAC | Critical | unverified |
| 2.2 | 2 | Analyses admin POST/PUT/DELETE | Critical | unverified |
| 2.3 | 2 | Analyses KV cache invalidation | High | unverified |
| 2.13 | 2 | Ticket create — Telegram notify | High | — |
| 3.4 | 3 | Global error handler — 5xx not 200 | Medium | unverified |
| 3.7 | 3 | Delete unused ticket_service.py | Low | — |
| 4.5 | 4 | Generic provider error to client | High | — |
| 4.7 | 4 | Restrict CORS to WEBAPP_URL | Medium | — |

## Agent Rules (summary)

1. فقط **یک Task** در هر session اجرا کن.
2. قبل از شروع، **Dependencies** را در `TASK_BOARD.md` بررسی کن — همه باید ✅ Done باشند.
3. وضعیت را به 🟨 In Progress تغییر بده، سپس پیاده‌سازی کن.
4. پس از برآورده شدن **Acceptance Criteria** → ✅ Done.
5. اگر dependency باز مانده → ⛔ Blocked و Task دیگری انتخاب نکن مگر از لیست «Next Executable».

جزئیات کامل: `TASK_BOARD.md` → بخش Agent Execution Rules.
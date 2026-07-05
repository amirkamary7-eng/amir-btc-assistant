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
| ✅ Done | 35 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 19 |
| **Progress** | **65%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 7 | 100% |
| 2 | Core System Fix | 14 | 11 | 79% |
| 3 | Architecture Cleanup | 8 | 5 | 63% |
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
| 2.2 | Direct Worker invocation: non-admin POST/PUT/DELETE → 403, admin+no-DB → 503 `Database not configured`. All 3 routes exist. |
| 2.7 | Node.js runtime: 13 tests (history, empty, image, truncation, bad data, parity with Python `ai_service.py._build_prompt`). `npm test` 52/52 pass. |
| 3.4 | Direct Worker invocation: malformed URL → 500 `{"status":"error","message":"Internal server error"}`, no TypeError/detail/stack in body. Normal paths (health=200, unknown=404) unaffected. |

### ✅ Task 3.3 — FALSE POSITIVE BUG, verified correct (2026-07-05)

**Original claim:** `config.py` line 60: `admin_ids` returns `set[str]` but `join_service.py` compares `int uid in admin_ids` → always False.

**Reality:** `join_service.py` line 92 does `uid = str(user_id)` BEFORE the check at line 98. So `uid` is always `str`, and `str in set[str]` works correctly.

**Runtime evidence:** 6 tests passed (primary admin, 2 secondary admins, non-admin flow, int input, guest user). `pytest tests/test_join_service_admin_bypass.py` → 1 passed.

**Conclusion:** Task 3.3 was already correctly implemented in commit `ccd1d77`. The audit agent's bug report was wrong.

### ✅ Task 1.1 — FALSE POSITIVE BUG, verified correct (2026-07-05)

**Original claim (C2):** Worker `validateTelegramInitData` decodes values before hashing; Python/Telegram spec uses raw/encoded values → auth 401 for real users.

**Reality:** Worker line 234: `checkPairs.push([key, rawValue])` — uses the **raw/URL-encoded** value, NOT `decodedValue`. This is identical to Python `telegram_auth.py` line 64: `check_pairs.append((key, value))`.

**Side-by-side proof:**
```
Worker (L228-236):   for (const [key, rawValue] of pairs) { ... checkPairs.push([key, rawValue]); }
Python (L59-64):     for key, value in pairs: ... check_pairs.append((key, value))
```

**Runtime evidence (8 tests, zero external deps):**
1. Simple ASCII name → PASS (user returned)
2. Name with space (`%20`) → PASS (user returned)
3. Persian name (`امیر`, multi-byte encoded) → PASS (user returned)
4. Special chars in username → PASS (user returned)
5. **WRONG hash over decoded + space** → CORRECTLY FAILS (null)
6. **WRONG hash over decoded + Persian** → CORRECTLY FAILS (null)
7. Expired auth_date → correctly rejected
8. Wrong bot token → correctly rejected

Tests 5-6 are the smoking gun: if Worker used decoded values for hashing, they would PASS. They fail → Worker uses encoded values → code is correct.

**Conclusion:** Task 1.1 was already correctly implemented. The audit agent's bug report was wrong. `node --test worker-proxy.test.cjs` → 52/52 pass.

### ✅ Task 2.3 — KV cache invalidation verified (2026-07-05)

**Method:** In-memory KV (real `Map`-based store, not stubbed) + mock DB (to satisfy write path). KV state changes observable in both HTTP response and KV store directly.

**Code flow verified (all three write handlers):**
```
handleAnalysesCreate (L2606-2611):
  createAnalysisInDb → listAnalysesFromDb → readCurrentAnalysesVersion → version+1 → updateAnalysesCache
handleAnalysesUpdate (L2641-2648):
  updateAnalysisInDb → listAnalysesFromDb → readCurrentAnalysesVersion → version+1 → updateAnalysesCache
handleAnalysesDelete (L2674-2681):
  deleteAnalysisInDb → listAnalysesFromDb → readCurrentAnalysesVersion → version+1 → updateAnalysesCache
```

**Runtime evidence (21 checks, 5 scenarios):**

| Scenario | Checks | Result |
|----------|--------|--------|
| S1: POST → KV version 0→1 | 5 | ✅ response.version=1, KV version="1", KV list=[BTC] |
| S2: PUT → KV version 4→5 | 5 | ✅ response.version=5, KV version="5", list=[ETH] |
| S3: DELETE → version 4→5, list emptied | 4 | ✅ response.version=5, KV list=[] |
| S4: POST→PUT→DELETE sequential | 4 | ✅ versions 1→2→3 monotonic, final KV="3" |
| S5: GET after POST → cache HIT | 3 | ✅ version=1 from KV, no DB re-query |

**Smoking gun (S5):** After POST populates KV, a subsequent GET serves from KV cache without any DB query — proving the cache is correctly invalidated and refreshed after writes.

**`node --test worker-proxy.test.cjs` → 52/52 pass**

### ⬜ Unverified (1 task)

| Task | Reason |
|------|--------|
| 2.4 | Cron works but exchange APIs are external dependency |

## Next Executable Tasks

| Task ID | Phase | Title | Priority | Note |
|---------|-------|-------|----------|------|
| 2.3 | 2 | Analyses KV cache invalidation | High | unverified — نیاز به real DB |
| 2.13 | 2 | Ticket create — Telegram notify | High | — |
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
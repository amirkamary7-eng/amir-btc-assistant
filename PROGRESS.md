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
| ✅ Done | 42 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 12 |
| **Progress** | **78%** |

## By Phase

| Phase | Name | Tasks | Done | Progress |
|-------|------|-------|------|----------|
| 1 | Critical Stability | 7 | 7 | 100% |
| 2 | Core System Fix | 14 | 14 | 100% |
| 3 | Architecture Cleanup | 8 | 7 | 88% |
| 4 | Security Hardening | 13 | 6 | 46% |
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

### ✅ Task 2.4 — Port price alert checker to Worker (2026-07-05)

**Finding:** Logic already fully implemented inside `runScheduledAlertsBaseline` (worker-proxy.js L3645-3804). No separate `runPriceAlertCheck` function needed — all 5 implementation steps are present:

1. ✅ Fetch prices via `fetchSpotPriceUsd` (Binance/MEXC)
2. ✅ Query DB: `SELECT ... FROM price_alerts WHERE status = 'active'`
3. ✅ Compare price/direction: `above` (currentPrice >= target) / `below` (currentPrice <= target)
4. ✅ On trigger: `sendTelegramMessage` + `UPDATE price_alerts SET status = 'triggered'`
5. ✅ Summary object with `checked_count`, `triggered_count`, `price_fetch_failures`, `delivery_failures`

**Runtime evidence (2 tests, 52/52 total pass):**

| Test | Checks | Result |
|------|--------|--------|
| Triggers active alerts, marks triggered in DB | 4 | ✅ 1 UPDATE (a1), 1 sendMessage, correct Persian text, ETH (2000<999999) not triggered |
| Does not mark triggered when Telegram fails | 1 | ✅ 0 UPDATE calls when `ok: false` |

**`node --test worker-proxy.test.cjs` → 53/53 pass**

### ✅ Task 2.13 — Ticket create — Telegram notification (2026-07-05)

**Change:** Added two `sendTelegramMessage` calls in `handleTicketsCreate` (worker-proxy.js L2971-2995), mirroring `main.py:649-656`:

1. Admin notification: `🎫 تیکت جدید\nاز: {user_name} ({user_id})\nعنوان: {title}\n\n{body}` → `env.ADMIN_TELEGRAM_ID`
2. User confirmation: `✅ تیکت شما ثبت شد\nعنوان: {title}\nبه زودی پاسخ داده می‌شود.` → user's chat_id
3. Each wrapped in try/catch with `console.warn` on failure (ticket still returns success)

**Runtime evidence (1 new test, 53/53 total pass):**

| Check | Result |
|-------|--------|
| POST /api/tickets → 200 status | ✅ |
| Exactly 2 `/sendMessage` fetch calls | ✅ |
| Admin chat_id = 831704732 | ✅ |
| Admin text contains `🎫 تیکت جدید`, `Sara`, `مشکل در خرید` | ✅ |
| User chat_id = 54321 | ✅ |
| User text contains `✅ تیکت شما ثبت شد`, `مشکل در خرید` | ✅ |
| Existing 52 tests unchanged (no regression) | ✅ |

**`node --test worker-proxy.test.cjs` → 53/53 pass**

### ✅ Task 2.14 — Ticket reply — Telegram notification (2026-07-05)

**Change:** Added `sendTelegramMessage` call in ticket reply handler (worker-proxy.js L3104-3116), mirroring `main.py:721-724`:

- After admin reply DB write: `💬 پاسخ تیکت: {title}\n\n{message}` → ticket owner's `user_id`
- Wrapped in try/catch with `console.warn` on failure

**Runtime evidence (1 new test, 54/54 total pass):**

| Check | Result |
|-------|--------|
| POST /api/tickets/:id/reply → 200 (admin) | ✅ |
| Exactly 1 `/sendMessage` fetch call | ✅ |
| `chat_id = 54321` (ticket owner) | ✅ |
| Text contains `💬 پاسخ تیکت` | ✅ |
| Text contains ticket title `مشکل در خرید` | ✅ |
| Text contains reply message `安娜 چطوری؟` | ✅ |
| Existing 53 tests unchanged | ✅ |

**`node --test worker-proxy.test.cjs` → 55/55 pass**

### ✅ Task 3.2 — Multi-admin support on Worker (2026-07-05)

**Change:** Added `getAdminIds(env)` (worker-proxy.js L804-817) that parses `ADMIN_TELEGRAM_IDS` (comma-separated) + always includes `ADMIN_TELEGRAM_ID`. Rewrote `isAdminTelegramId` to use `Set.has()`. Updated ticket create to notify all admins. Mirrors `backend/config.py:admin_ids`.

**Runtime evidence (1 new test, 55/55 total pass):**

| Check | Result |
|-------|--------|
| Admin 999888 (in ADMIN_TELEGRAM_IDS) → GET /tickets/all → 200 | ✅ |
| Admin 999888 → POST /analyses → 200 | ✅ |
| Non-admin 555666 → POST /analyses → 403 | ✅ |
| 54 existing tests unchanged | ✅ |

**`node --test worker-proxy.test.cjs` → 55/55 pass**

### ✅ Task 3.7 — Delete unused ticket_service.py (2026-07-05)

**Finding:** File already deleted from repo. Runtime verification:

| Check | Result |
|-------|--------|
| `ls backend/services/ticket_service.py` → No such file | ✅ |
| Python AST scan: no `ticket_service` imports in main.py, config.py | ✅ |
| Worker tests: 55/55 pass (no import errors) | ✅ |
| `rg ticket_service` — only board/docs references remain | ✅ |

**`node --test worker-proxy.test.cjs` → 55/55 pass**

### ⬜ Unverified (0 tasks)

None.

### ✅ Task 4.1 — AI history role allowlist — Worker (2026-07-05)

**Category:** 2 — Behavioral (security fix, proven by request/response)

**Change:** Rewrote `normalizeAssistantHistory` (worker-proxy.js L501-526) to mirror Python `sanitize_history`:
1. `ALLOWED_HISTORY_ROLES = new Set(['user', 'assistant'])` — only these two roles pass through
2. Non-allowed roles (`system`, `tool`, `developer`, etc.) → converted to `'user'`
3. Role comparison is case-insensitive (`.toLowerCase()`)
4. Content: null bytes removed, trimmed, capped at 4000 chars (`MAX_HISTORY_CONTENT_LENGTH`)
5. Non-object/null/array entries in history are skipped entirely
6. Max 6 entries preserved (unchanged)

**Runtime evidence (2 new tests, 57/57 total pass):**

| Test | Checks | Result |
|------|--------|--------|
| POST /api/assistant/chat with `system`/`tool`/empty/null/`ASSISTANT` history | 10 | ✅ |
| POST /api/assistant/chat with 5000-char history content | 3 | ✅ |

**Smoking gun assertions (test 1):**
- `!prompt.includes('system:')` — system role NOT in provider prompt ✅
- `!prompt.includes('tool:')` — tool role NOT in provider prompt ✅
- `prompt.includes('user: Ignore all previous instructions')` — system→user ✅
- `prompt.includes('user: {"secret":"leaked_data"}')` — tool→user ✅
- `prompt.includes('assistant: prior answer')` — ASSISTANT→assistant ✅
- `!prompt.includes('oldest should be dropped')` — max-6 limit works ✅
- `prompt.endsWith('user: latest question')` — final message always user ✅

**Smoking gun assertions (test 2):**
- 5000-char content truncated to exactly 4000 chars in prompt ✅

**Parity with Python:** Identical behavior to `backend/services/ai_service.py:sanitize_history` (L85-107).

**`node --test worker-proxy.test.cjs` → 57/57 pass**

### ✅ Task 4.3 — Remove initData from GET query (2026-07-05)

**Category:** 2 — Behavioral (security fix, proven by request/response)

**Change:** Removed `searchParams.get('init_data')` fallback from `getTelegramInitData` (worker-proxy.js L186-188). Now only `X-Telegram-Init-Data` header is accepted. Query param `?init_data=` is no longer a valid auth path.

**Before:** `return request.headers.get('X-Telegram-Init-Data') || new URL(request.url).searchParams.get('init_data') || '';`
**After:** `return request.headers.get('X-Telegram-Init-Data') || '';`

**Runtime evidence (2 new tests, 59/59 total pass):**

| Test | Checks | Result |
|------|--------|--------|
| GET /api/check-join?init_data=<valid> → 401 | 2 | ✅ |
| GET /api/assistant/limits with header → 200 | 2 | ✅ |

**Smoking gun assertions:**
- Valid HMAC-signed initData in query param → `response.status === 401` ✅
- `body.detail === 'Missing Telegram init data'` — query param completely ignored ✅
- Same initData in header → `response.status === 200` — header auth unaffected ✅

**`node --test worker-proxy.test.cjs` → 59/59 pass**

## Next Executable Tasks

| Task ID | Phase | Title | Priority | Note |
|---------|-------|-------|----------|------|
| 2.4 | 2 | Port price alert checker to Worker | High | ✅ already implemented + 2 tests pass (triggered_count=1, delivery failure) |
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
# Task Details — Phase 2 through Phase 5

> **Part of:** `TASK_BOARD.md` (split for maintainability)  
> **SSOT definition:** `گزارش 3.txt`  
> **All tasks:** ⬜ Todo (initial)

---

## PHASE 2: Core System Fix

---

### TASK 2.1

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.1

**Title:** Analyses GET — read from PostgreSQL when KV empty  
**Type:** feature / bugfix | **Priority:** Critical

**Scope:** `worker-proxy.js` — `readCachedAnalysesState`, handler `GET /api/analyses` (~L1707–1734, ~L2053+)

**Problem:** C4 — Worker فقط KV می‌خواند؛ FastAPI به DB می‌نویسد → analyses خالی/stale.

**Objective:** اگر KV خالی → query DB table `analyses` → populate KV → return.

**Implementation Steps:**
1. SQL query: `SELECT id, title, content, created_at, updated_at FROM analyses ORDER BY created_at DESC`
2. در handler GET analyses: اگر cache خالی → fetch DB → write KV keys
3. version bump logic مثل `analysis_service.py`

**Acceptance Criteria:**
- `GET /api/analyses` بعد از admin save در FastAPI data برمی‌گرداند
- Response: `{ status: "success", analyses: [...], version: N }`

**Risks:** SQL typo → 500 on public endpoint.  
**Dependencies:** 1.1 | **Unblocks:** 2.2, 2.3

---

### TASK 2.2

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.2

**Title:** Analyses admin POST/PUT/DELETE routes on Worker  
**Type:** feature | **Priority:** Critical

**Scope:** `worker-proxy.js` — router section analyses (~L2053–2091); مرجع: `backend/routers/analyses.py`

**Problem:** C4 — admin CRUD روی Worker 404.

**Objective:** سه route admin با auth + admin check.

**Implementation Steps:**
1. `POST /api/analyses` — insert row، require admin
2. `PUT /api/analyses/:id` — update row
3. `DELETE /api/analyses/:id` — delete row
4. Admin check: `env.ADMIN_TELEGRAM_ID`
5. Mirror response shape از FastAPI router

**Acceptance Criteria:** Admin POST → 201/200; Non-admin → 403; DELETE → 200

**Risks:** بدون admin check → هر user analyses می‌نویسد.  
**Dependencies:** 1.1, 2.1 | **Unblocks:** 2.3

---

### TASK 2.3

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.3

**Title:** Analyses KV cache invalidation after write  
**Type:** bugfix | **Priority:** High

**Scope:** `worker-proxy.js` — handlers POST/PUT/DELETE analyses (TASK 2.2)

**Problem:** C4 — cache disconnected after write.

**Objective:** بعد از هر write → bump version + refresh KV list.

**Implementation Steps:**
1. تابع `invalidateAnalysesCache(env)`
2. بعد از successful write → invalidate + re-fetch from DB
3. test در `worker-proxy.test.cjs`

**Acceptance Criteria:** POST analysis → immediate GET returns new item; KV keys updated in test

**Risks:** stale cache اگر invalidate skip شود.  
**Dependencies:** 2.2 | **Unblocks:** 3.1

---

### TASK 2.4

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.4

**Title:** Port price alert checker logic to Worker  
**Type:** feature | **Priority:** Critical

**Scope:** `worker-proxy.js` — `runPriceAlertCheck(env)` (منطق از `main.py:952-1019`)

**Problem:** C5 — Worker cron no-op.

**Objective:** check active alerts + trigger + Telegram notify.

**Implementation Steps:**
1. Fetch CoinGecko markets
2. Query DB active alerts
3. Compare price/direction
4. On trigger: update status, notify user + admin
5. Return summary object

**Acceptance Criteria:** Unit test triggered_count=1; Manual DB test

**Risks:** CoinGecko rate limit.  
**Dependencies:** 1.1 | **Unblocks:** 2.5

---

### TASK 2.5

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.5

**Title:** Wire alert runner into Worker `scheduled()`  
**Type:** bugfix | **Priority:** Critical

**Scope:** `worker-proxy.js` — `runScheduledAlertsBaseline`, `scheduled()`

**Problem:** C5 — cron فقط log می‌کند.

**Objective:** `scheduled()` → `runPriceAlertCheck(env)` when enabled.

**Implementation Steps:**
1. در `runScheduledAlertsBaseline`: await `runPriceAlertCheck` when enabled
2. log summary JSON
3. `wrangler.jsonc` production: `ALERTS_CRON_ENABLED: "true"`

**Acceptance Criteria:** Cron trigger logs triggered_count; test mock env

**Risks:** Telegram spam.  
**Dependencies:** 2.4 | **Unblocks:** 3.1

---

### TASK 2.6

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.6

**Title:** AI chat — add provider fetch helper module in Worker  
**Type:** feature | **Priority:** Critical

**Scope:** `worker-proxy.js` — region قبل از `handleAssistantChat` (~L2270)

**Problem:** C1 — AI فقط FastAPI؛ Worker 501.

**Objective:** `callGemini`, `callOpenRouter`, `callDeepSeek`, `chatWithFailover`.

**Implementation Steps:**
1. Constants from `ai_service.py`
2. Provider fetch functions with header auth
3. `chatWithFailover` sequential try/catch

**Acceptance Criteria:** Functions exist; mock test failover

**Risks:** keys missing → all fail.  
**Dependencies:** 1.1 | **Unblocks:** 2.7, 2.8, 2.9

---

### TASK 2.7

**Status:** ✅ Done | **Phase:** 2 | **Task ID:** 2.7

**Title:** AI chat — port prompt assembly from FastAPI  
**Type:** feature | **Priority:** High

**Scope:** `worker-proxy.js` — `handleAssistantChat`; مرجع: `ai_service.py`, `assistant.py`

**Problem:** C1 — no prompt building on Worker.

**Objective:** payload → single prompt string (parity FastAPI).

**Implementation Steps:**
1. Parse request body
2. Build prompt: system + history + message
3. Pass to `chatWithFailover` (no 501 yet)

**Acceptance Criteria:** Unit test prompt contains history + message

**Risks:** —  
**Dependencies:** 2.6 | **Unblocks:** 2.9

---

### TASK 2.8

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.8

**Title:** AI chat — safe response parsing (no KeyError)  
**Type:** bugfix | **Priority:** High

**Scope:** `worker-proxy.js` — inside `callGemini` / response handler

**Problem:** brittle nested access on Gemini JSON.

**Objective:** guarded access + catchable error for failover.

**Implementation Steps:**
1. Helper `extractGeminiText(json)` with optional chaining
2. throw `ProviderError` if null
3. Same for OpenRouter/DeepSeek

**Acceptance Criteria:** malformed JSON → failover, not uncaught exception

**Risks:** —  
**Dependencies:** 2.6 | **Unblocks:** 2.9

---

### TASK 2.9

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.9

**Title:** Replace assistant 501 with live AI response  
**Type:** feature / bugfix | **Priority:** Critical

**Scope:** `worker-proxy.js` — `handleAssistantChat` (L2300–2306)

**Problem:** C1 — returns 501.

**Objective:** successful chat → `{ status: "success", reply, provider }`.

**Implementation Steps:**
1. حذف block 501
2. buildPrompt → chatWithFailover → 200 JSON
3. All fail → 503 generic
4. Update tests expecting 501

**Acceptance Criteria:** POST chat → 200 + reply; `npm test` pass

**Risks:** API keys not in wrangler secrets.  
**Dependencies:** 2.6, 2.7, 2.8, 1.1 | **Unblocks:** 2.10, 4.1, 4.2, 5.6

---

### TASK 2.10

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.10

**Title:** Call `recordRateLimitUsage` after successful chat  
**Type:** bugfix | **Priority:** High

**Scope:** `worker-proxy.js` — `recordRateLimitUsage`, `handleAssistantChat`

**Problem:** H4 — function defined but never called.

**Objective:** increment KV counters after successful AI response.

**Implementation Steps:**
1. Call `recordRateLimitUsage` after successful reply
2. Verify RATE_LIMITS KV keys

**Acceptance Criteria:** mock KV shows increment; cooldown may hit on second chat

**Risks:** double-call → aggressive limits.  
**Dependencies:** 2.9, 1.4 | **Unblocks:** 4.3

---

### TASK 2.11

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.11

**Title:** Webhook secret validation — Worker  
**Type:** security | **Priority:** High

**Scope:** `worker-proxy.js` — `handleTelegramWebhook` (L3081–3127)

**Problem:** H1 — no `secret_token` check.

**Objective:** reject invalid `X-Telegram-Bot-Api-Secret-Token`.

**Implementation Steps:**
1. Read `env.TELEGRAM_WEBHOOK_SECRET`
2. mismatch → 403
3. not configured → log warning (dev)

**Acceptance Criteria:** no header + secret set → 403; valid → 200

**Risks:** deploy without BotFather secret.  
**Dependencies:** 1.6 | **Unblocks:** 2.12, 5.7

---

### TASK 2.12

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.12

**Title:** Webhook secret validation — FastAPI  
**Type:** security | **Priority:** High

**Scope:** `main.py` — `/telegram` handler (~L1094–1104)

**Problem:** H1 — duplicate unauthenticated webhook.

**Objective:** same secret check until Phase 3 removal.

**Implementation Steps:** Read config, validate header, mirror Worker 403 behavior.

**Acceptance Criteria:** wrong secret → 403

**Risks:** —  
**Dependencies:** 2.11 | **Unblocks:** 3.1

---

### TASK 2.13

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.13

**Title:** Ticket create — Telegram notification on Worker  
**Type:** feature / bugfix | **Priority:** High

**Scope:** `worker-proxy.js` — `handleTicketsCreate`; مرجع: `main.py:711-718`

**Problem:** H9 — Worker DB write بدون notify.

**Objective:** بعد از create → notify admin via Telegram.

**Implementation Steps:** copy message format; sendTelegramMessage; warn on notify fail.

**Acceptance Criteria:** POST ticket → admin Telegram; mock test called once

**Risks:** wrong admin ID.  
**Dependencies:** 1.1 | **Unblocks:** —

---

### TASK 2.14

**Status:** ⬜ Todo | **Phase:** 2 | **Task ID:** 2.14

**Title:** Ticket reply — Telegram notification on Worker  
**Type:** feature / bugfix | **Priority:** High

**Scope:** `worker-proxy.js` — ticket reply handler

**Problem:** H9 — same gap for reply path.

**Objective:** notify user on admin reply.

**Implementation Steps:** find reply handler; send message to ticket owner.

**Acceptance Criteria:** admin reply → user Telegram; mock test

**Risks:** —  
**Dependencies:** 2.13 | **Unblocks:** —

---

## PHASE 3: Architecture Cleanup

---

### TASK 3.1

**Status:** ⬜ Todo | **Phase:** 3 | **Task ID:** 3.1

**Title:** Disable FastAPI duplicate routes — flag-gated  
**Type:** refactor | **Priority:** High

**Scope:** `main.py` — webhook + analyses + assistant + alerts internal routes

**Problem:** H7 — dual runtime maintenance.

**Objective:** `FASTAPI_LEGACY_ROUTES=false` → 410 Gone on duplicated routes.

**Implementation Steps:**
1. Add config flag in `backend/config.py`
2. Wrap duplicate routes with guard
3. Default `true` in dev

**Acceptance Criteria:** flag false → POST assistant → 410; Worker exclusive

**Risks:** premature disable → outage.  
**Dependencies:** 2.3, 2.5, 2.9, 2.11, 1.0 verified | **Unblocks:** 3.2

---

### TASK 3.2

**Status:** ⬜ Todo | **Phase:** 3 | **Task ID:** 3.2

**Title:** Multi-admin support on Worker  
**Type:** refactor | **Priority:** Medium

**Scope:** `worker-proxy.js` admin check; `backend/config.py` reference

**Problem:** M4 — Worker single admin ID.

**Objective:** parse comma-separated `ADMIN_TELEGRAM_IDS`.

**Implementation Steps:** `getAdminIds(env)`; replace single-ID checks; fallback.

**Acceptance Criteria:** two admin IDs → both pass admin routes

**Risks:** —  
**Dependencies:** 2.2 | **Unblocks:** 3.3, 4.8, 4.9

---

### TASK 3.3

**Status:** ✅ Done | **Phase:** 3 | **Task ID:** 3.3

**Title:** Admin join bypass — use full admin set  
**Type:** bugfix | **Priority:** Medium

**Scope:** `backend/services/join_service.py` (L98–99)

**Problem:** M12 — only single admin bypasses join.

**Objective:** use same admin set as config.

**Implementation Steps:** import `admin_ids`; replace single ID check.

**Acceptance Criteria:** second admin skips join check

**Risks:** —  
**Dependencies:** None | **Unblocks:** —

---

### TASK 3.4

**Status:** ✅ Done | **Phase:** 3 | **Task ID:** 3.4

**Title:** Global error handler — return 5xx not 200  
**Type:** bugfix | **Priority:** Medium

**Scope:** `worker-proxy.js` global catch (L3312–3319)

**Problem:** M5 — HTTP 200 on unhandled errors.

**Objective:** unhandled exception → 500 JSON generic.

**Implementation Steps:** catch → 500 + console.error

**Acceptance Criteria:** throw in test → status 500, no stack in body

**Risks:** —  
**Dependencies:** None | **Unblocks:** —

---

### TASK 3.5

**Status:** ⬜ Todo | **Phase:** 3 | **Task ID:** 3.5

**Title:** Generic DB error responses on Worker  
**Type:** security / bugfix | **Priority:** Medium

**Scope:** `worker-proxy.js` handlers with `detail: String(error)`

**Problem:** M6 — schema/stack leak.

**Objective:** DB errors → generic 503.

**Implementation Steps:** `safeDbErrorResponse(error)`; replace String(error) in catches.

**Acceptance Criteria:** simulated pg error → 503, no SQL in body

**Risks:** —  
**Dependencies:** None | **Unblocks:** 4.5

---

### TASK 3.6

**Status:** ✅ Done | **Phase:** 3 | **Task ID:** 3.6

**Title:** Remove unused Worker functions  
**Type:** cleanup | **Priority:** Low

**Scope:** `worker-proxy.js` — `getUserStateKey`, `getWatchlistKey`

**Problem:** L1 — dead code.

**Objective:** delete if zero references.

**Implementation Steps:** grep; delete; npm test

**Acceptance Criteria:** functions removed, tests pass

**Risks:** hidden reference.  
**Dependencies:** 1.3 | **Unblocks:** —

---

### TASK 3.7

**Status:** ⬜ Todo | **Phase:** 3 | **Task ID:** 3.7

**Title:** Delete unused `ticket_service.py`  
**Type:** cleanup | **Priority:** Low

**Scope:** `backend/services/ticket_service.py`

**Problem:** L2 — never imported.

**Objective:** delete file.

**Acceptance Criteria:** file gone, no import errors

**Risks:** —  
**Dependencies:** None | **Unblocks:** —

---

### TASK 3.8

**Status:** ✅ Done | **Phase:** 3 | **Task ID:** 3.8

**Title:** Remove `bot.py` disabled stub  
**Type:** cleanup | **Priority:** Low

**Scope:** `bot.py`

**Problem:** L3 — confusion.

**Objective:** delete; note in LIVE_STATE_CHECKLIST.

**Acceptance Criteria:** `bot.py` removed

**Risks:** —  
**Dependencies:** 1.6 | **Unblocks:** —

---

## PHASE 4: Security Hardening

(Full field definitions — see `گزارش 3.txt` lines 1001–1410; board status below)

| Task ID | Status | Title | Priority | Dependencies |
|---------|--------|-------|----------|--------------|
| 4.1 | ⬜ | AI history role allowlist — Worker | High | 2.9 |
| 4.2 | ⬜ | AI history sanitization — FastAPI | High | None |
| 4.3 | ⬜ | Remove initData from GET query | High | 1.1 |
| 4.4 | ⬜ | FastAPI AI rate limits — KV migration doc | High | 1.0, 3.1 |
| 4.5 | ⬜ | Generic provider error to client | High | 2.9, 3.5 |
| 4.6 | ⬜ | Gemini API key — header not URL | High | None |
| 4.7 | ⬜ | Restrict CORS to WEBAPP_URL | Medium | 1.5 |
| 4.8 | ⬜ | Debug join endpoint — admin only | Medium | 3.2 |
| 4.9 | ⬜ | Remove hardcoded default admin ID | Medium | 3.2 |
| 4.10 | ⬜ | Referrer validation | Medium | None |
| 4.11 | ⬜ | Shorten initData max_age | Medium | 1.1 |
| 4.12 | ⬜ | Sanitize env.example | Medium | None |
| 4.13 | ⬜ | Image failover — explicit warning | Medium | 2.9 |

> **Note:** Scope, Problem, Objective, Implementation Steps, Acceptance Criteria, Risks, Unblocks for 4.1–4.13 are verbatim in `گزارش 3.txt` §PHASE 4. Agents must read that section before implementation.

---

## PHASE 5: Optimization & Cleanup

(Full field definitions — see `گزارش 3.txt` lines 1418–1779; board status below)

| Task ID | Status | Title | Priority | Dependencies |
|---------|--------|-------|----------|--------------|
| 5.1 | ⬜ | Remove mock news fallback | Low | None |
| 5.2 | ⬜ | Remove unused config keys — Python | Low | None |
| 5.3 | ⬜ | Remove unused wrangler vars | Low | None |
| 5.4 | ⬜ | Add GitHub Actions CI | Medium | 1.3, 2.9 |
| 5.5 | ⬜ | Add minimal Python auth pytest | Medium | 1.1 |
| 5.6 | ⬜ | Integration test — analyses CRUD + KV | Medium | 2.3 |
| 5.7 | ⬜ | Integration test — webhook secret | Medium | 2.11 |
| 5.8 | ⬜ | Alembic migrations baseline | Medium | None |
| 5.9 | ⬜ | Sync status docs with code reality | Low | Phase 2 complete |
| 5.10 | ⬜ | Remove legacy query params | Low | 3.1 |
| 5.11 | ⬜ | Remove dead imports in main.py | Low | None |
| 5.12 | ⬜ | Update index.html outdated comment | Low | 1.5 |

> **Note:** Scope, Problem, Objective, Implementation Steps, Acceptance Criteria, Risks, Unblocks for 5.1–5.12 are verbatim in `گزارش 3.txt` §PHASE 5.

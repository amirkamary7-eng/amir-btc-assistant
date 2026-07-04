# TASK BOARD — Amir BTC Assistant

> **Single Source of Truth (SSOT):**  
> - **تعریف backlog:** `گزارش 3.txt`  
> - **وضعیت + ترتیب اجرا:** **این فایل** (`TASK_BOARD.md`) + `docs/TASK_BOARD_DETAILS_P2-P5.md`  
> **تاریخ بازسازی:** 2026-07-02  
> **نکته:** گزارش 3.txt در پایان «۴۸ تسک» ذکر می‌کند؛ در متن backlog **۵۴** تسک با شناسه صریح (1.0–5.12) وجود دارد. این board بر اساس **۵۴** تسک عمل می‌کند.

### File layout

| File | Contents |
|------|----------|
| `TASK_BOARD.md` | Progress, dependency graph, master table, Phase 1 full details, agent rules |
| `docs/TASK_BOARD_DETAILS_P2-P5.md` | Phase 2–3 full details; Phase 4–5 (see also `گزارش 3.txt`) |
| `گزارش 3.txt` | Canonical verbatim definitions for all 54 tasks |

---

## Agent Execution Rules

1. **یک Task در هر session** — Agent فقط یک Task ID را اجرا کند.
2. **بررسی Dependency اجباری** — قبل از شروع، همه Taskهای listed در **Dependencies** باید ✅ Done باشند. در غیر این صورت Task را شروع **نکن**.
3. **تغییر وضعیت:**
   - شروع کار → 🟨 In Progress
   - Acceptance Criteria برآورده شد → ✅ Done
   - dependency باز / blocker خارجی → ⛔ Blocked
4. **Progress** فقط از وضعیت‌های این فایل محاسبه می‌شود (`PROGRESS.md` خلاصه است).
5. **تعریف فیلدها** در `گزارش 3.txt` ثابت است؛ این فایل وضعیت **Status** را اضافه می‌کند.
6. **هیچ تصمیم معماری جدید** — فقط Implementation Steps و Acceptance Criteria هر Task.

### Status Legend

| Icon | Status |
|------|--------|
| ⬜ | Todo |
| 🟨 | In Progress |
| ✅ | Done |
| ⛔ | Blocked |

---

## Progress (live)

| Metric | Count |
|--------|-------|
| Total tasks | 54 |
| ✅ Done | 14 |
| 🟨 In Progress | 0 |
| ⛔ Blocked | 0 |
| ⬜ Todo | 40 |
| **Overall** | **26%** |

### By Phase

| Phase | Name | Tasks | Done | % |
|-------|------|-------|------|---|
| 1 | Critical Stability | 7 | 7 | 100% |
| 2 | Core System Fix | 14 | 0 | 0% |
| 3 | Architecture Cleanup | 8 | 5 | 63% |
| 4 | Security Hardening | 13 | 2 | 15% |
| 5 | Optimization & Cleanup | 12 | 0 | 0% |

---

## Dependency Graph (خلاصه)

```
1.0 (manual verify)
  └─► 1.1 HMAC fix ─► 1.2 test fixture ─► 1.3 npm test
1.4 KV split (independent)
1.5 API_BASE inject (independent)
1.6 webhook runbook (after 1.0)

Phase 1 complete ─► Phase 2:
  2.1 analyses DB read ─► 2.2 admin CRUD ─► 2.3 KV invalidation
  2.4 alert runner logic ─► 2.5 wire scheduled()
  2.6 AI helpers ─► 2.7 Gemini ─► 2.8 failover ─► 2.9 replace 501 ─► 2.10 recordRateLimit
  2.11 webhook secret Worker ─► 2.12 webhook secret FastAPI
  2.13 ticket notify create ─► 2.14 ticket notify reply

Phase 2 ─► Phase 3:
  3.x decommission, error handling, multi-admin, dead code

Phase 3 ─► Phase 4:
  4.x security hardening

Phase 4 ─► Phase 5:
  5.x cleanup, CI, docs, migrations
```

---

## Master Table — Execution Order

| Exec# | Task ID | Phase | Title | Priority | Status | Dependencies | Unblocks |
|------:|---------|-------|-------|----------|--------|--------------|----------|
| 1 | 1.0 | 1 | ثبت وضعیت live deployment | Critical | ✅ | None | 1.6, 3.1 |
| 2 | 1.1 | 1 | Fix Worker Telegram HMAC | Critical | ✅ | None | 1.2, 2.9, auth tasks |
| 3 | 1.2 | 1 | Fix buildInitData test helper | High | ✅ | 1.1 | 1.3 |
| 4 | 1.3 | 1 | Wire npm test | High | ✅ | 1.2 | 5.4 |
| 5 | 1.4 | 1 | Separate KV namespace IDs | Critical | ✅ | None | 2.3, 2.10, 4.3 |
| 6 | 1.5 | 1 | Inject API_BASE at Pages build | Critical | ✅ | None | E2E, Mini App |
| 7 | 1.6 | 1 | Runbook — single webhook target | High | ✅ | 1.0 | 2.11, 3.1 |
| 8 | 2.1 | 2 | Analyses GET — read from PostgreSQL | Critical | ⬜ | 1.1 | 2.2, 2.3 |
| 9 | 2.2 | 2 | Analyses admin POST/PUT/DELETE | Critical | ⬜ | 1.1, 2.1 | 2.3 |
| 10 | 2.3 | 2 | Analyses KV cache invalidation | High | ⬜ | 2.2 | 3.1 |
| 11 | 2.4 | 2 | Port price alert checker to Worker | Critical | ⬜ | 1.1 | 2.5 |
| 12 | 2.5 | 2 | Wire alert runner into scheduled() | Critical | ⬜ | 2.4 | 3.1 |
| 13 | 2.6 | 2 | AI chat — provider fetch helpers | Critical | ⬜ | 1.1 | 2.7, 2.8, 2.9 |
| 14 | 2.7 | 2 | AI chat — port prompt assembly | High | ⬜ | 2.6 | 2.9 |
| 15 | 2.8 | 2 | AI chat — safe response parsing | High | ⬜ | 2.6 | 2.9 |
| 16 | 2.9 | 2 | Replace assistant 501 with live AI | Critical | ⬜ | 2.6, 2.7, 2.8, 1.1 | 2.10, 4.1, 4.2, 5.6 |
| 17 | 2.10 | 2 | Call recordRateLimitUsage after chat | High | ⬜ | 2.9, 1.4 | 4.3 |
| 18 | 2.11 | 2 | Webhook secret validation — Worker | High | ⬜ | 1.6 | 2.12, 5.7 |
| 19 | 2.12 | 2 | Webhook secret validation — FastAPI | High | ⬜ | 2.11 | 3.1 |
| 20 | 2.13 | 2 | Ticket create — Telegram notify | High | ⬜ | 1.1 | — |
| 21 | 2.14 | 2 | Ticket reply — Telegram notify | High | ⬜ | 2.13 | — |
| 22 | 3.1 | 3 | Disable FastAPI duplicate routes | High | ⬜ | 2.3, 2.5, 2.9, 2.11, 1.0 | 3.2 |
| 23 | 3.2 | 3 | Multi-admin support on Worker | Medium | ⬜ | 2.2 | 3.3, 4.8, 4.9 |
| 24 | 3.3 | 3 | Admin join bypass — full admin set | Medium | ✅ | None | — |
| 25 | 3.4 | 3 | Global error handler — 5xx not 200 | Medium | ✅ | None | — |
| 26 | 3.5 | 3 | Generic DB error responses | Medium | ✅ | None | 4.5 |
| 27 | 3.6 | 3 | Remove unused Worker functions | Low | ✅ | 1.3 | — |
| 28 | 3.7 | 3 | Delete unused ticket_service.py | Low | ✅ | None | — |
| 29 | 3.8 | 3 | Remove bot.py disabled stub | Low | ⬜ | 1.6 | — |
| 30 | 4.1 | 4 | AI history role allowlist — Worker | High | ⬜ | 2.9 | 4.2 |
| 31 | 4.2 | 4 | AI history sanitization — FastAPI | High | ✅ | None | — |
| 32 | 4.3 | 4 | Remove initData from GET query | High | ⬜ | 1.1 | 4.6 |
| 33 | 4.4 | 4 | FastAPI AI rate limits — KV migration doc | High | ⬜ | 1.0, 3.1 | — |
| 34 | 4.5 | 4 | Generic provider error to client | High | ⬜ | 2.9, 3.5 | — |
| 35 | 4.6 | 4 | Gemini API key — header not URL | High | ✅ | None | — |
| 36 | 4.7 | 4 | Restrict CORS to WEBAPP_URL | Medium | ⬜ | 1.5 | — |
| 37 | 4.8 | 4 | Debug join endpoint — admin only | Medium | ⬜ | 3.2 | — |
| 38 | 4.9 | 4 | Remove hardcoded default admin ID | Medium | ⬜ | 3.2 | — |
| 39 | 4.10 | 4 | Referrer validation | Medium | ⬜ | None | — |
| 40 | 4.11 | 4 | Shorten initData max_age | Medium | ⬜ | 1.1 | — |
| 41 | 4.12 | 4 | Sanitize env.example | Medium | ⬜ | None | — |
| 42 | 4.13 | 4 | Image failover — explicit warning | Medium | ⬜ | 2.9 | — |
| 43 | 5.1 | 5 | Remove mock news fallback | Low | ⬜ | None | — |
| 44 | 5.2 | 5 | Remove unused config keys — Python | Low | ⬜ | None | — |
| 45 | 5.3 | 5 | Remove unused wrangler vars | Low | ⬜ | None | — |
| 46 | 5.4 | 5 | Add GitHub Actions CI | Medium | ⬜ | 1.3, 2.9 | — |
| 47 | 5.5 | 5 | Add minimal Python auth pytest | Medium | ⬜ | 1.1 | — |
| 48 | 5.6 | 5 | Integration test — analyses CRUD + KV | Medium | ⬜ | 2.3 | — |
| 49 | 5.7 | 5 | Integration test — webhook secret | Medium | ⬜ | 2.11 | — |
| 50 | 5.8 | 5 | Alembic migrations baseline | Medium | ⬜ | None | — |
| 51 | 5.9 | 5 | Sync status docs with code reality | Low | ⬜ | Phase 2 complete | — |
| 52 | 5.10 | 5 | Remove legacy query params | Low | ⬜ | 3.1 | — |
| 53 | 5.11 | 5 | Remove dead imports in main.py | Low | ⬜ | None | — |
| 54 | 5.12 | 5 | Update index.html outdated comment | Low | ⬜ | 1.5 | — |

---

## Next Executable Tasks (dependencies satisfied)

> با وضعیت فعلی، این Taskها dependency باز ندارند و می‌توانند شروع شوند:

| Task ID | Title | Priority |
|---------|-------|----------|
| 3.8 | Remove bot.py disabled stub | Low |
| 4.10 | Referrer validation | Medium |
| 4.12 | Sanitize env.example | Medium |
| 5.1 | Remove mock news fallback | Low |
| 5.2 | Remove unused config keys | Low |
| 5.3 | Remove unused wrangler vars | Low |
| 5.8 | Alembic migrations baseline | Medium |
| 5.11 | Remove dead imports in main.py | Low |

**توصیه Trae (Top priority):** 1.1 → 1.5 → 1.4 → 1.2+1.3 → … (see `گزارش 3.txt` Top 10)

---

# Task Details

> هر Task: **Status** زنده در board؛ بقیه فیلدها از `گزارش 3.txt`.

## PHASE 1: Critical Stability

---

### TASK 1.0

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.0

**Title:** ثبت وضعیت live deployment (manual checklist)

**Type:** cleanup (ops verification)

**Priority:** Critical

**Scope:**
- فایل جدید: `docs/LIVE_STATE_CHECKLIST.md` (فقط checklist — بدون تغییر runtime)

**Problem:** Audit: webhook URL، `API_BASE` واقعی، production = Worker یا FastAPI → **unknown from code** (گزارش §8, §13).

**Objective:** یک checklist ثابت بساز که قبل از هر deploy پر شود؛ ambiguity حذف شود.

**Implementation Steps:**
1. فایل `docs/LIVE_STATE_CHECKLIST.md` بساز.
2. این موارد را به‌صورت checkbox بنویس:
   - URL فعلی webhook در BotFather
   - Host واقعی Mini App (Pages URL)
   - مقدار `window.API_BASE` در browser DevTools
   - آیا `/api/health` روی همان host پاسخ می‌دهد
   - Worker name فعال: `amir-btc-assistant-api-production` یا FastAPI
3. فیلدهای «نتیجه» خالی بگذار (operator پر می‌کند).

**Acceptance Criteria:**
- فایل checklist وجود دارد با 5 مورد بالا
- هیچ کد runtime تغییر نکرده

**Risks:** بدون این، تسک‌های بعدی روی host اشتباه deploy می‌شوند.

**Dependencies:** None

**Unblocks:** 1.6, 3.1

---

### TASK 1.1

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.1

**Title:** Fix Worker Telegram HMAC — استفاده از raw URL-encoded values

**Type:** bugfix / security

**Priority:** Critical

**Scope:**
- `worker-proxy.js` — تابع `validateTelegramInitData` (حدود L202–255)
- مرجع: `backend/services/telegram_auth.py:59-69`

**Problem:** C2 — Worker قبل از hash مقدار decode می‌کند؛ Python/spec از encoded استفاده می‌کند → auth 401 برای کاربر واقعی.

**Objective:** `dataCheckString` دقیقاً مثل Python: `${key}=${rawValue}` (encoded، نه decoded).

**Implementation Steps:**
1. در حلقه `for (const [key, rawValue] of pairs)` به‌جای push کردن `decodedValue`، `rawValue` را در `checkPairs` نگه دار.
2. `hash` را هم از raw pair بخوان (decode فقط برای `auth_date` و parse `user`).
3. `dataCheckString` را از `checkPairs` sorted بساز: `` `${key}=${rawValue}` ``.
4. decoded values فقط برای validation بعد از hash موفق استفاده شوند.

**Acceptance Criteria:**
- `validateTelegramInitData` با initData واقعی Telegram (از Mini App) user برمی‌گرداند
- Manual: `POST /api/users/bootstrap` با header `X-Telegram-Init-Data` → 200 (نه 401)

**Risks:** اگر فقط decode path عوض شود و hash path نه → همه auth می‌شکنند.

**Dependencies:** None

**Unblocks:** 1.2, 2.9, تمام auth-dependent tasks

---

### TASK 1.2

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.2

**Title:** Fix `buildInitData` test helper — align با Telegram spec

**Type:** test

**Priority:** High

**Scope:**
- `worker-proxy.test.cjs` — تابع `buildInitData` (L45–63)

**Problem:** H10 — test helper با impl اشتباه Worker match می‌کرد، نه Telegram spec.

**Objective:** `dataCheckString` در test از URL-encoded values استفاده کند (مثل TASK 1.1).

**Implementation Steps:**
1. در `buildInitData`، قبل از hash، values را URL-encode کن در `dataCheckString`.
2. hash را روی encoded string بساز.
3. خروجی نهایی initData string را با `encodeURIComponent` per-value بساز (مثل Telegram).
4. یک test اضافه کن که initData ساخته‌شده توسط `validateTelegramInitData` accept شود.

**Acceptance Criteria:**
- `node --test worker-proxy.test.cjs` — auth-related tests pass
- test جدید: round-trip `buildInitData` → `validateTelegramInitData` → user.id موجود

**Risks:** test سبز ولی production خراب اگر TASK 1.1 انجام نشده باشد.

**Dependencies:** 1.1

**Unblocks:** 1.3

---

### TASK 1.3

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.3

**Title:** Wire `npm test` به worker test suite

**Type:** test

**Priority:** High

**Scope:**
- `package.json` — script `"test"` (L7)

**Problem:** H11 — 34 test وجود دارد ولی `npm test` placeholder است.

**Objective:** `"test": "node --test worker-proxy.test.cjs"`

**Implementation Steps:**
1. در `package.json` خط 7 را عوض کن.
2. `npm test` اجرا کن.
3. اگر test مربوط به assistant 501 fail شد، expectation را بررسی کن (501 عمدی تا TASK 2.9).

**Acceptance Criteria:**
- `npm test` exit code 0 (یا فقط tests مربوط به 501 که بعداً در 2.9 update می‌شوند — فعلاً pass)
- حداقل 34 test اجرا می‌شوند

**Risks:** CI بعداً block می‌شود اگر tests شکسته باشند.

**Dependencies:** 1.2 (ترجیحاً)

**Unblocks:** 5.4 (CI)

---

### TASK 1.4

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.4

**Title:** Separate KV namespace IDs — staging vs production

**Type:** bugfix / deployment

**Priority:** Critical

**Scope:**
- `wrangler.jsonc` — بخش‌های `env.staging.kv_namespaces` (L59–75) و `env.production.kv_namespaces` (L100–116)

**Problem:** C3 — هر دو env همان 4 namespace ID را share می‌کنند → bleed.

**Objective:** staging و production namespace IDهای مجزا داشته باشند.

**Implementation Steps:**
1. در `wrangler.jsonc` برای staging، comment اضافه کن: «IDs must differ from production».
2. staging IDs را با placeholder `REPLACE_STAGING_*` جایگزین کن (4 binding).
3. در `docs/LIVE_STATE_CHECKLIST.md` یا comment در wrangler: دستور `wrangler kv namespace create "JOIN_CACHE" --env staging` (×4) و paste ID.
4. production IDs فعلی را نگه دار (یا اگر operator تأیید کرد، production-only بمانند).

**Acceptance Criteria:**
- هیچ ID مشترک بین staging و production در `wrangler.jsonc` نباشد
- `wrangler deploy --dry-run --env staging` syntax error ندهد

**Risks:** deploy با placeholder ID → runtime KV error.

**Dependencies:** None (operator باید IDs واقعی بسازد)

**Unblocks:** 2.3, 2.10, 4.3

---

### TASK 1.5

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.5

**Title:** Inject `API_BASE` at Pages build time

**Type:** bugfix / deployment

**Priority:** Critical

**Scope:**
- `scripts/prepare-pages.mjs`
- `index.html` (L12–13)

**Problem:** C6 — `API_BASE = location.origin` و Pages/Worker جدا → `/api/*` ممکن است 404 بدهد.

**Objective:** build script مقدار `WORKER_API_URL` را در `index.html` inject کند.

**Implementation Steps:**
1. در `prepare-pages.mjs` بعد از copy، `index.html` در output را بخوان.
2. خط `<script>window.API_BASE = ...` را replace کن:
   - اگر `process.env.WORKER_API_URL` set → استفاده کن
   - else → fallback `window.location.origin` (رفتار فعلی)
3. `index.html` source: comment را update کن («build injects WORKER_API_URL»).
4. در `env.example` یک خط `WORKER_API_URL=https://amir-btc-assistant-api-production.<account>.workers.dev` اضافه کن.

**Acceptance Criteria:**
- `WORKER_API_URL=https://test.example npm run cf:pages:prepare`
- `webapp/pages-dist/index.html` شامل `window.API_BASE = "https://test.example"` باشد
- بدون env var → fallback origin

**Risks:** URL اشتباه → تمام API calls fail.

**Dependencies:** None

**Unblocks:** E2E tests, Mini App prod

---

### TASK 1.6

**Status:** ✅ Done  
**Phase:** 1  
**Task ID:** 1.6

**Title:** Runbook — single webhook target

**Type:** cleanup

**Priority:** High

**Scope:**
- `docs/LIVE_STATE_CHECKLIST.md` (append)
- `env.example` (L20 webhook URL comment)

**Problem:** H7 — duplicate webhook Worker + FastAPI؛ target unknown.

**Objective:** runbook قطعی: فقط Worker webhook؛ FastAPI webhook disable.

**Implementation Steps:**
1. بخش «Webhook Cutover» به checklist اضافه کن:
   - Set webhook: `https://<worker-host>/telegram`
   - Set `secret_token` (placeholder برای TASK 2.11)
   - Remove/stop FastAPI webhook registration
2. در `main.py` comment بالای `/telegram` route: «DEPRECATED — use Worker webhook only».
3. `env.example` webhook URL را به Worker production URL template update کن.

**Acceptance Criteria:**
- runbook 3 step دارد
- `main.py` deprecation comment دارد (بدون حذف route — آن در Phase 3)

**Risks:** هر دو webhook فعال → duplicate `/start` messages.

**Dependencies:** 1.0 (operator confirms current state)

**Unblocks:** 2.11, 3.1

---

<!-- PHASE2_START -->

> **Phase 2–5 task details:** `docs/TASK_BOARD_DETAILS_P2-P5.md` (linked part of this board)  
> **Phase 1 task details:** above in this file  
> **Canonical definitions:** `گزارش 3.txt` — in case of any drift, گزارش 3 wins for field content.

**End of TASK_BOARD.md**

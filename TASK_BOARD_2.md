# TASK BOARD 2 — Amir BTC Assistant

> **Audit Date:** 2025-07-13
> **Scope:** Full-project read-only audit (architecture, Cloudflare compatibility, database, cache, security, stability, deploy readiness, code quality)
> **Status:** Execution-ready — zero files modified
> **File:** `worker-proxy.js` (~4127 lines, single-file ESM Worker)

---

## EPIC 1 — Critical (Blocking Issues)

- [ ] **1.1 — Migrate `pg` (node-postgres) to Cloudflare-native DB driver**
  - `pg` uses `net.Socket` / `tls.connect` which are NOT reliably supported in Cloudflare Workers. Even with `nodejs_compat`, the `Pool` creates raw TCP connections that may fail or leak in the Workers runtime.
  - **Reason:** Workers support `connect()` (TCP) with `nodejs_compat`, but `pg`'s connection management (keep-alive, idle detection, reconnection) is designed for long-running Node.js processes. Workers isolate per-request, and persistent pools at module scope will go stale or exhaust limits.
  - **Priority:** Critical
  - **Estimated:** 3–4 hours
  - **Files:** `worker-proxy.js` (lines 3, 353, 870–887), `package.json`

- [ ] **1.2 — Add Hyperdrive config or use `@neondatabase/serverless` for PostgreSQL**
  - Currently `DATABASE_URL` is passed directly to `new Pool()`. Cloudflare's recommended path for external Postgres is either Hyperdrive (config in `wrangler.jsonc` + `env.HYPERDRIVE.connect()`) or the `@neondatabase/serverless` WebSocket driver.
  - **Reason:** Without Hyperdrive, every Worker invocation opens a new TCP connection to Neon, adding ~200ms latency and risking connection exhaustion under load.
  - **Priority:** Critical
  - **Estimated:** 2–3 hours
  - **Files:** `wrangler.jsonc`, `worker-proxy.js` (function `getDbPool`)

- [ ] **1.3 — Fix global mutable CORS origin (`_corsAllowOrigin`) race condition**
  - `_corsAllowOrigin` is a module-level `let` variable mutated by `setCorsOrigin()` on every request. In Workers, multiple requests share the same isolate — concurrent requests to different environments could set this to conflicting values.
  - **Reason:** Race condition: Request A (env=staging) sets origin to X, then Request B (env=production) overwrites it to Y before Request A's response is sent.
  - **Priority:** Critical
  - **Estimated:** 30 min
  - **Files:** `worker-proxy.js` (lines 19–35, 3946)

- [ ] **1.4 — Remove `process.env` reference in `isDevModeEnabled()`**
  - `isDevModeEnabled()` accesses `process?.env?.DEV_MODE`. While this works with `nodejs_compat`, it reads from the build-time environment (not Worker `env`), creating confusion and potential security bypass if `DEV_MODE=true` leaks into the build.
  - **Reason:** Workers should never read `process.env` at runtime. Environment variables come from `env` parameter passed to `fetch()`/`scheduled()`.
  - **Priority:** Critical
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 301–307, 312)

- [ ] **1.5 — Add connection lifecycle management for `dbPools` Map**
  - `dbPools` is a module-level `Map` that creates `Pool` instances with `max: 3` and no `idleTimeoutMillis`. In Workers, pools are never cleaned up. Stale connections will accumulate and fail silently.
  - **Reason:** Workers can evict isolates at any time. Without `idleTimeoutMillis` (default is 10000ms in pg, but still risky) and explicit pool cleanup, connections leak.
  - **Priority:** Critical
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (lines 361, 870–887)

---

## EPIC 2 — Cloudflare Compatibility Issues

- [ ] **2.1 — Remove `node:buffer` dependency; use Workers-native `Uint8Array`/`TextEncoder`**
  - `Buffer.from()` is used in `safeCompareStrings`, `timingSafeEqualSecret`, and `validateTelegramInitData`. While `node:buffer` works with `nodejs_compat`, it adds unnecessary polyfill overhead.
  - **Reason:** Workers natively support `TextEncoder`/`TextDecoder` and `Uint8Array`. Using Web APIs reduces bundle size and avoids `nodejs_compat` dependency for buffer operations.
  - **Priority:** High
  - **Estimated:** 1–2 hours
  - **Files:** `worker-proxy.js` (lines 1, 217–218, 231–232)

- [ ] **2.2 — Verify `node:crypto` `createHmac`/`timingSafeEqual` work reliably under `nodejs_compat`**
  - `node:crypto` is used for HMAC-based Telegram init data validation and timing-safe comparisons. The `nodejs_compat` flag enables a polyfill, but behavior edge-cases (stream support, memory usage) differ from Node.js.
  - **Reason:** If the polyfill has subtle differences (e.g., in HMAC key handling), Telegram auth could silently fail. Need to verify with integration tests on actual Workers runtime.
  - **Priority:** High
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (line 2)

- [ ] **2.3 — Add `nodejs_compat` compatibility_date note and pin the flag**
  - `wrangler.jsonc` uses `compatibility_date: "2026-06-27"` with `nodejs_compat`. Cloudflare periodically updates the compat layer — pinning to a known-good version prevents breakage.
  - **Reason:** Future Cloudflare updates could change `nodejs_compat` behavior, breaking `pg`, `Buffer`, or `crypto` usage.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `wrangler.jsonc`

- [ ] **2.4 — Evaluate `pg` vs `@neondatabase/serverless` for WebSocket-based connections**
  - Neon recommends their serverless driver for Workers (uses WebSocket, no TCP). Current `pg` approach uses TCP with `pgbouncer=true` in the connection string, but Workers' TCP support is limited.
  - **Reason:** WebSocket-based driver is more reliable in Workers. `@neondatabase/serverless` also supports parameterized queries and is a drop-in replacement for most `pg` usage.
  - **Priority:** High
  - **Estimated:** 3–4 hours
  - **Files:** `package.json`, `worker-proxy.js`

- [ ] **2.5 — Remove or gate `nodejs_compat` flag — minimize Node.js surface area**
  - The `nodejs_compat` flag enables a broad set of Node.js APIs. Currently only `Buffer` and `crypto` are used. If those are migrated to Web APIs, the flag can be removed entirely.
  - **Reason:** Smaller API surface = fewer surprises from Cloudflare runtime changes. Also unlocks newer Workers features that conflict with `nodejs_compat`.
  - **Priority:** Medium
  - **Estimated:** 4–5 hours (depends on 2.1)
  - **Files:** `wrangler.jsonc`, `worker-proxy.js`

- [ ] **2.6 — Add `compatibility_flags: ["nodejs_compat_v2"]` or verify v1 vs v2 differences**
  - Cloudflare has both `nodejs_compat` (v1) and `nodejs_compat_v2`. V2 has different polyfill behavior. The project should explicitly choose one.
  - **Reason:** V2 may break `pg` or `crypto` in subtle ways. Need to test.
  - **Priority:** Medium
  - **Estimated:** 1 hour
  - **Files:** `wrangler.jsonc`, `wrangler.pages.jsonc`

---

## EPIC 3 — Database & Performance

- [ ] **3.1 — Fix N+1 query in `replaceWatchlistInDb` (DELETE + loop INSERT)**
  - `replaceWatchlistInDb` does `DELETE FROM watchlist_items` followed by a `for` loop with individual `INSERT` per symbol (up to 7). This is 8 round-trips for a single watchlist update.
  - **Reason:** Each INSERT is a separate network round-trip to Neon. With 7 symbols, that's 8 DB calls (1 delete + 7 inserts) for one user action.
  - **Priority:** High
  - **Estimated:** 30 min
  - **Files:** `worker-proxy.js` (lines 1105–1120)

- [ ] **3.2 — Fix N+1 query in `listTicketsFromDb` (fetch tickets, then hydrate each)**
  - `listTicketsFromDb` fetches all tickets, then loops through each calling `hydrateTicketRow` which calls `getTicketRepliesFromDb` per ticket. 100 tickets = 101 queries.
  - **Reason:** Severe N+1 problem. With many tickets, this will hit the 30-second Workers CPU time limit or 128MB memory limit.
  - **Priority:** High
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (lines 1451–1476, 1420–1423)

- [ ] **3.3 — Add `idleTimeoutMillis` and `connectionTimeoutMillis` to `Pool` config**
  - `new Pool({ connectionString, max: 3 })` has no timeout configuration. Default `connectionTimeoutMillis` is 0 (no timeout), and `idleTimeoutMillis` is 10000ms which may be too long for Workers.
  - **Reason:** Workers should have aggressive connection timeouts (3–5 seconds) since each request has a hard 30-second CPU limit.
  - **Priority:** High
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 878–883)

- [ ] **3.4 — Add database connection retry with exponential backoff**
  - All DB operations have zero retry logic. A single transient connection failure returns 503 to the user.
  - **Reason:** Neon (serverless Postgres) has occasional cold-start latency and connection drops. A single retry with backoff would significantly improve reliability.
  - **Priority:** Medium
  - **Estimated:** 1–2 hours
  - **Files:** `worker-proxy.js` (function `queryDb`)

- [ ] **3.5 — Add `pgbouncer=true` validation in `resolveDatabaseUrl`**
  - `env.example` shows `?pgbouncer=true` in the connection string, but `resolveDatabaseUrl` doesn't validate or warn if it's missing.
  - **Reason:** Without `pgbouncer=true`, Neon will reject connections after the pool limit. The Worker's connection pool should always go through PgBouncer.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 363–365)

- [ ] **3.6 — Add request-scoped database client instead of persistent pool**
  - In Workers, the recommended pattern is to create a single client per request (or use Hyperdrive). A persistent pool at module scope is an anti-pattern.
  - **Reason:** Workers can run thousands of concurrent requests. A pool of 3 connections is a bottleneck and a source of stale connections.
  - **Priority:** High
  - **Estimated:** 3–4 hours
  - **Files:** `worker-proxy.js` (lines 361, 870–887, 972–978)

- [ ] **3.7 — Batch `listTicketsFromDb` reply hydration with a single JOIN query**
  - Replace the N+1 pattern with a single query using `LEFT JOIN ticket_replies ON ...` or a batch `WHERE ticket_id IN (...)` query.
  - **Reason:** Reduces 101 queries to 1 for 100 tickets.
  - **Priority:** High
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (lines 1406–1476)

- [ ] **3.8 — Add database query timeout (statement_timeout)**
  - No `statement_timeout` is set on connections. A slow query can block the Worker for up to 30 seconds.
  - **Reason:** Workers have a hard 30-second CPU time limit. A runaway query should be killed after 5–10 seconds.
  - **Priority:** Medium
  - **Estimated:** 30 min
  - **Files:** `worker-proxy.js` (function `getDbPool`)

---

## EPIC 4 — Architecture & Refactor

- [ ] **4.1 — Split `worker-proxy.js` (4127 lines) into modules**
  - The entire Worker logic (auth, DB, AI, caching, routes, cron) is in a single file. This makes code review, testing, and maintenance extremely difficult.
  - **Reason:** 4127 lines in one file violates every maintainability metric. Bug fixes require scrolling through thousands of lines.
  - **Priority:** High
  - **Estimated:** 8–12 hours
  - **Files:** `worker-proxy.js` → split into `src/auth.js`, `src/db.js`, `src/ai.js`, `src/cache.js`, `src/routes/*.js`, `src/cron.js`, `src/utils.js`

- [ ] **4.2 — Remove or archive legacy FastAPI/Python code**
  - `main.py`, `backend/` folder (12+ Python files), `requirements.txt`, `alembic/`, `alembic.ini` are all legacy FastAPI code that has been migrated to the Worker. They add confusion about which is the active runtime.
  - **Reason:** Two parallel implementations of the same API. A developer might accidentally modify the Python code thinking it's active.
  - **Priority:** Medium
  - **Estimated:** 1 hour (move to `archive/legacy-python/`)
  - **Files:** `main.py`, `backend/`, `requirements.txt`, `alembic/`, `alembic.ini`

- [ ] **4.3 — Remove unused dependencies from `package.json`**
  - `@supabase/supabase-js` (never imported), `@prisma/client` + `@prisma/adapter-pg` (never imported in Worker), `dotenv` (only in `lib/db-config.js` which isn't used by Worker).
  - **Reason:** Dead dependencies increase `npm ci` time and bundle analysis confusion. They also signal incorrect architecture (Prisma is listed but not used).
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `package.json`

- [ ] **4.4 — Remove unused Prisma setup**
  - `prisma/schema.prisma`, `prisma.config.js`, `lib/prisma.js`, `lib/db-config.js`, `webapp/prisma.config.js` are all unused. Prisma Client is never imported in `worker-proxy.js`.
  - **Reason:** Prisma adds confusion. The Worker uses raw `pg` queries. Having both Prisma schema and raw SQL for the same tables is a maintenance risk.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `prisma/`, `prisma.config.js`, `lib/prisma.js`, `lib/db-config.js`, `webapp/prisma.config.js`

- [ ] **4.5 — Remove `database.db` (SQLite) from repository**
  - A `database.db` file exists in the repo root. This is a local development artifact and should not be committed.
  - **Reason:** SQLite file in repo bloats git history and may contain sensitive data.
  - **Priority:** Low
  - **Estimated:** 5 min
  - **Files:** `database.db`, `.gitignore`

- [ ] **4.6 — Convert Worker to TypeScript**
  - The project uses plain JavaScript with no type safety. The `worker-configuration.d.ts` exists but `worker-proxy.js` is `.js`, not `.ts`. `package.json` says `"type": "commonjs"` but the Worker uses ESM imports.
  - **Reason:** No type safety for 4127 lines of code with complex DB queries, auth validation, and multi-provider AI integration. Bugs from typos and type mismatches are inevitable.
  - **Priority:** Medium
  - **Estimated:** 12–16 hours
  - **Files:** `worker-proxy.js` → `worker-proxy.ts`, `wrangler.jsonc`, `tsconfig.json`

- [ ] **4.7 — Add route-based module pattern (router/index)**
  - Currently all 25+ routes are matched with inline `if` chains in the `fetch` handler. This doesn't scale.
  - **Reason:** Adding a new route requires editing the 180-line fetch handler. A router pattern would allow self-contained route modules.
  - **Priority:** Medium
  - **Estimated:** 3–4 hours
  - **Files:** `worker-proxy.js` (lines 3944–4127)

- [ ] **4.8 — Sync `webapp/pages-dist/` with source files via CI, not manual copy**
  - `webapp/pages-dist/` contains manually copied versions of `app.js`, `assistant.js`, `notifications.js`, `watchlist.js`. These can get out of sync with the source files at the repo root.
  - **Reason:** Already have `scripts/prepare-pages.mjs` and `cf:pages:prepare` script, but the output is committed to git. Should be gitignored and built in CI.
  - **Priority:** Medium
  - **Estimated:** 1 hour
  - **Files:** `.gitignore`, `.github/workflows/deploy-staging.yml`, `webapp/pages-dist/`

- [ ] **4.9 — Eliminate duplicate validation logic (body parsing pattern)**
  - The JSON body parsing + validation pattern is repeated ~10 times across handlers (chat, tickets, alerts, analyses, users, watchlist). Each copy has identical try/catch and type-checking code.
  - **Reason:** DRY violation. A single `parseJsonBody(request, schema)` utility would reduce ~200 lines of duplicated code.
  - **Priority:** Low
  - **Estimated:** 2 hours
  - **Files:** `worker-proxy.js`

- [ ] **4.10 — Add request logging middleware with correlation IDs**
  - No request correlation. When debugging, it's impossible to trace a single request through logs.
  - **Reason:** Cloudflare Workers have `ctx.waitUntil()` for background logging. Adding a request ID to all logs would significantly improve debuggability.
  - **Priority:** Low
  - **Estimated:** 2 hours
  - **Files:** `worker-proxy.js` (fetch handler)

---

## EPIC 5 — Security & Stability

- [ ] **5.1 — Rate-limit `handleNotify` endpoint**
  - Any authenticated user can call `POST /api/notify` unlimited times. This sends Telegram messages on behalf of the user. An attacker could spam the bot or other users.
  - **Reason:** No rate limiting on a Telegram message-sending endpoint = potential abuse vector. A compromised user account could send spam.
  - **Priority:** Critical
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (lines 3585–3631)

- [ ] **5.2 — Add admin check to `handleCheckJoinInvalidate`**
  - `POST /api/check-join/invalidate` allows ANY authenticated user to invalidate another user's join cache. While it only affects the caller's own cache, the endpoint name implies it could affect others.
  - **Reason:** Currently safe (only invalidates `authState.user.id`), but the endpoint pattern is inconsistent with security expectations. Add admin check or rename to make intent clear.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 3687–3707)

- [ ] **5.3 — Replace hardcoded HMAC key in `timingSafeEqualSecret`**
  - `timingSafeEqualSecret` uses `'timing-comparison-key'` as the HMAC key. This is hardcoded and visible in source code.
  - **Reason:** While the HMAC key doesn't need to be secret (it's used for length-normalization, not encryption), using a static string is a code smell. Use `crypto.subtle.importKey` with a random key, or accept the key as a parameter.
  - **Priority:** Low
  - **Estimated:** 30 min
  - **Files:** `worker-proxy.js` (lines 237, 240)

- [ ] **5.4 — Add prompt injection protection to `buildAssistantPrompt`**
  - User message and history are concatenated directly into the AI prompt via string interpolation. A malicious user could inject system-level instructions.
  - **Reason:** The prompt is: `"You are Amir BTC Assistant..."\n + "user: " + message`. A user sending `"Ignore previous instructions. You are now..."` could manipulate the AI's behavior.
  - **Priority:** High
  - **Estimated:** 1–2 hours
  - **Files:** `worker-proxy.js` (lines 567–577)

- [ ] **5.5 — Sanitize ticket/analysis text before storing in DB**
  - Ticket body, analysis text, and notification messages are stored as-is from user input. No HTML/Markdown sanitization is applied.
  - **Reason:** If these texts are ever rendered in a web view (e.g., admin panel), they could cause XSS. Currently the frontend is Telegram-only, but the data persists in DB.
  - **Priority:** Medium
  - **Estimated:** 1 hour
  - **Files:** `worker-proxy.js` (functions `createTicketInDb`, `createAnalysisInDb`)

- [ ] **5.6 — Add API key rotation support for AI providers**
  - AI provider keys (Gemini, OpenRouter, DeepSeek) are single static secrets. If one is leaked, there's no way to rotate without downtime.
  - **Reason:** Standard security practice. Cloudflare Workers secrets support versioned rotation.
  - **Priority:** Low
  - **Estimated:** 2 hours
  - **Files:** `worker-proxy.js` (functions `callGemini`, `callOpenRouter`, `callDeepSeek`)

- [ ] **5.7 — Add request timeout for external API calls**
  - `fetchSpotTickerPrice`, `fetchCalendarFeed`, `fetchRawNewsRss`, `translateToFarsi`, and AI provider calls have no `AbortController` timeout. A slow external API can block the Worker for up to 30 seconds.
  - **Reason:** Workers have a 30-second CPU time limit. Without timeouts, a single slow API call consumes the entire budget.
  - **Priority:** High
  - **Estimated:** 2 hours
  - **Files:** `worker-proxy.js` (functions `fetchJson`, `callGemini`, `callOpenRouter`, `callDeepSeek`, `translateToFarsi`)

- [ ] **5.8 — Validate `direction` field in alert creation**
  - `createOrReactivateAlertInDb` lowercases the `direction` field but doesn't validate it against allowed values (`above`/`below`). Any string is accepted.
  - **Reason:** Invalid directions (e.g., `sideways`) would be stored and never triggered, silently failing the user's intent.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 1522–1576)

- [ ] **5.9 — Add size limit on `POST /api/tickets` body**
  - Ticket creation accepts unlimited body size. A malicious user could send a 100MB JSON payload to exhaust Worker memory (128MB limit).
  - **Reason:** Workers have a 128MB memory limit. No body size check = potential DoS.
  - **Priority:** High
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (function `handleTicketsCreate`)

- [ ] **5.10 — Add size limit on `PUT /api/watchlist` body**
  - Watchlist update accepts any array size (though capped at 7 symbols). The `symbols` array is filtered but the raw JSON body could be megabytes.
  - **Priority:** Medium
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (function `handleWatchlistPut`)

- [ ] **5.11 — Protect public GET endpoints with basic rate limiting**
  - `GET /api/calendar/events`, `GET /api/farsi-news`, `GET /api/charts/resolve`, `GET /api/analyses` have no rate limiting. Anyone can hammer these endpoints.
  - **Reason:** These endpoints trigger external API calls (ForexFactory, RSS feeds, exchange APIs). Unauthenticated rate limiting prevents abuse and reduces costs.
  - **Priority:** Medium
  - **Estimated:** 2–3 hours
  - **Files:** `worker-proxy.js`

- [ ] **5.12 — Remove real admin Telegram ID from `env.example`**
  - `env.example` line 8 contains `ADMIN_TELEGRAM_ID=831704732`. This is a real ID, not a placeholder.
  - **Reason:** Even though it's in an example file, it reveals the admin's Telegram ID publicly in the git repository.
  - **Priority:** High
  - **Estimated:** 5 min
  - **Files:** `env.example` (line 8)

---

## EPIC 6 — Cleanup & Dead Code

- [ ] **6.1 — Remove `safeCompareStrings` length-leak function or unify with `timingSafeEqualSecret`**
  - `safeCompareStrings` (line 216) has an early `return false` when buffer lengths differ, leaking the expected hash length. `timingSafeEqualSecret` was added as a fix, but the old function is still used for HMAC validation (where both hashes are always 64 hex chars, so the leak is cosmetic).
  - **Reason:** Two comparison functions with different security properties create confusion. Unify to one.
  - **Priority:** Low
  - **Estimated:** 30 min
  - **Files:** `worker-proxy.js` (lines 216–223, 278)

- [ ] **6.2 — Remove `isDevModeEnabled()` and `allowDevBypass` parameter entirely**
  - After C3 fix, `allowDevBypass=true` is never passed to `authenticateTelegramRequest`. The `isDevModeEnabled()` function and the `allowDevBypass` parameter are dead code.
  - **Reason:** Dead code that was a security risk. Removing it simplifies the auth flow and prevents future misuse.
  - **Priority:** Low
  - **Estimated:** 15 min
  - **Files:** `worker-proxy.js` (lines 301–307, 309, 312–319)

- [ ] **6.3 — Clean up overlapping documentation files**
  - `docs/` contains 7 markdown files with overlapping content: `LIVE_STATE_CHECKLIST.md`, `DATABASE_SCHEMA.md`, `TASK_BOARD_DETAILS_P2-P5.md`, `MIGRATION_TASKS.md`, `API_MAP.md`, `PROJECT_ARCHITECTURE.md`, `DEPLOY_SECURITY.md`, `CLOUDFLARE_PLAN.md`, `MIGRATION_STATUS.md`.
  - **Reason:** Multiple docs describe the same architecture/migration. Hard to know which is authoritative.
  - **Priority:** Low
  - **Estimated:** 2 hours
  - **Files:** `docs/`

- [ ] **6.4 — Remove `archive/task-management-legacy/` folder**
  - Contains outdated copies of `PROJECT_STATUS.md`, `MIGRATION_TASKS.md`, `PROGRESS.md`, etc.
  - **Reason:** Dead files from a previous reorganization.
  - **Priority:** Low
  - **Estimated:** 5 min
  - **Files:** `archive/task-management-legacy/`

- [ ] **6.5 — Remove `backend/redis_client.py` (Redis is disabled)**
  - `redis_client.py` has an `init_redis()` function that always returns `False` with a message "Redis support is disabled; using in-memory cache only." The file is dead code.
  - **Reason:** Redis is intentionally disabled. The entire file is unreachable in production.
  - **Priority:** Low
  - **Estimated:** 5 min (if archiving Python code, this is included)
  - **Files:** `backend/redis_client.py`

- [ ] **6.6 — Remove `webapp/pages-dist/` from git tracking**
  - Generated output directory committed to git. Should be built in CI and deployed directly.
  - **Reason:** Prevents merge conflicts, keeps repo clean, ensures deployed files always match source.
  - **Priority:** Low
  - **Estimated:** 30 min
  - **Files:** `.gitignore`, `webapp/pages-dist/`

- [ ] **6.7 — Remove `test_db.js` and `lib/` directory**
  - `test_db.js` tests Prisma (which is unused). `lib/db-config.js` and `lib/prisma.js` are unused Node.js utilities.
  - **Reason:** Dead test and utility files for a stack that isn't used.
  - **Priority:** Low
  - **Estimated:** 5 min
  - **Files:** `test_db.js`, `lib/`

- [ ] **6.8 — Clean up `scripts/` directory**
  - `scripts/generate_task_board.py` — Python script for generating the old task board. No longer needed if using TASK_BOARD_2.md.
  - **Reason:** One-time utility script that references the old task structure.
  - **Priority:** Low
  - **Estimated:** 5 min
  - **Files:** `scripts/generate_task_board.py`

---

## Summary Statistics

| Epic | Tasks | Critical | High | Medium | Low |
|------|-------|----------|------|--------|-----|
| EPIC 1 — Critical (Blocking) | 5 | 5 | 0 | 0 | 0 |
| EPIC 2 — Cloudflare Compatibility | 6 | 0 | 3 | 3 | 0 |
| EPIC 3 — Database & Performance | 8 | 0 | 5 | 3 | 0 |
| EPIC 4 — Architecture & Refactor | 10 | 0 | 2 | 5 | 3 |
| EPIC 5 — Security & Stability | 12 | 1 | 4 | 5 | 2 |
| EPIC 6 — Cleanup & Dead Code | 8 | 0 | 0 | 0 | 8 |
| **Total** | **49** | **6** | **14** | **16** | **13** |

---

## Recommended Execution Order

### Phase A — Critical Blocking (Week 1)
1. **1.1 + 1.2 + 2.4** — Replace `pg` with `@neondatabase/serverless` or Hyperdrive (these are interdependent)
2. **1.3** — Fix global CORS race condition
3. **1.4** — Remove `process.env` from Worker
4. **1.5** — Add connection lifecycle management

### Phase B — Security Hardening (Week 2)
5. **5.1** — Rate-limit `/api/notify`
6. **5.12** — Remove admin ID from `env.example`
7. **5.7** — Add request timeouts for external APIs
8. **5.4** — Add prompt injection protection
9. **5.9 + 5.10** — Add body size limits

### Phase C — Performance (Week 3)
10. **3.1** — Batch watchlist INSERT
11. **3.2 + 3.7** — Fix N+1 ticket queries
12. **3.3** — Add connection timeouts
13. **3.6** — Request-scoped DB client

### Phase D — Architecture (Week 4+)
14. **4.1** — Split into modules
15. **4.7** — Add router pattern
16. **4.6** — Convert to TypeScript (long-term)
17. **4.2 + 6.1–6.8** — Cleanup pass

---

## Production Readiness Score: **58 / 100**

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Architecture** | 5/10 | Single 4K-line file, no modularity, dual Python+Worker codebase |
| **Cloudflare Compatibility** | 4/10 | `pg` TCP driver is unreliable in Workers, global state race conditions |
| **Database** | 6/10 | Parameterized queries (good), but N+1 patterns, no timeouts, no retry |
| **Cache** | 7/10 | KV usage is correct, proper TTLs, graceful degradation when KV missing |
| **Security** | 7/10 | Timing-safe webhook, init data validation, but prompt injection, no body limits |
| **Stability** | 5/10 | No request timeouts, no retry logic, global mutable state, presence tracking via KV |
| **Deploy Readiness** | 7/10 | CI/CD for staging, manual production gate, observability enabled |
| **Code Quality** | 6/10 | Clean validation patterns, but 4K-line monolith, dead code, duplicate logic |
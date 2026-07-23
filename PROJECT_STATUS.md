# PROJECT_STATUS

## Source of Truth

| Role | File |
|------|------|
| **Task board + live status** | `TASK_BOARD.md` |
| **Progress summary** | `PROGRESS.md` |
| **Cloudflare plan** | `docs/CLOUDFLARE_PLAN.md` |

## Current State (2026-07-17)

- **Active runtime:** Cloudflare Worker (`worker-proxy.js`) + Cloudflare Pages
- **Database:** PostgreSQL (Supabase) via `@neondatabase/serverless`
- **Cache:** Cloudflare KV (4 namespaces: JOIN_CACHE, APP_CACHE, RATE_LIMITS, SESSION_CACHE)
- **Frontend:** `index.html`, `app.js`, `style.css`, `wallet.js`, `wallet.css`, `admin.js`, `assistant.js`, `notifications.js`
- **Worker modules:** `src/controllers/`, `src/repositories/`, `src/services/`
- **Legacy code:** REMOVED (backend/, main.py, alembic/, archive/, tests/)

## Removed in Cleanup (2026-07-17)

- `backend/` (14 Python files) — legacy FastAPI
- `main.py` — legacy FastAPI entry point
- `requirements.txt` — Python dependencies (unused)
- `alembic/`, `alembic.ini` — Python migrations (unused)
- `archive/task-management-legacy/` — outdated task management
- `tests/` — Python tests for deleted FastAPI
- `TASK_BOARD_2.md` — stale audit with 49 unchecked items
- `docs/TASK_BOARD_DETAILS_P2-P5.md` — never updated (all tasks still marked Todo)
- `docs/MIGRATION_STATUS.md` — self-deprecated
- `docs/MIGRATION_TASKS.md` — self-deprecated
- `docs/LIVE_STATE_CHECKLIST.md` — never filled by operator
- `docs/PROJECT_ARCHITECTURE.md` — described FastAPI as active runtime
- `docs/FOREX_DESIGN_REPORT.md` — unimplemented feature design
- `docs/verification-*.png` (2 files) — unreferenced screenshots
- `audit-report.txt` — historical LLM output
- `.env.example` — duplicate of `env.example`
- `scripts/generate_task_board.py` — one-time utility
- `scripts/migrate_admin_r4.sql` — orphaned migration
- `worker-configuration.d.ts` — 550KB auto-generated, unreferenced

// ═════════════════════════════════════════════════════════════════════════════
// Shared in-memory isolate cache for calendar events.
//
// Used by:
//   - worker-proxy.js: fetchCalendarEvents() (read + write) and
//     handleCalendarEvents() (read for transparency fields)
//   - src/cron/scheduler.js: Phase 1c calendar cache refresh on */15 cron
//     (write only)
//
// Why a separate module?
//   These variables were previously declared with `let` at module scope in
//   worker-proxy.js. When scheduler.js was extracted (PR #13) to a separate
//   ES module, those `let` declarations were no longer visible to it —
//   ES modules have isolated scopes and do not share module-level bindings.
//   The extraction left scheduler.js writing to undeclared identifiers
//   (`_calendarIsolateCache` and `_calendarIsolateCacheAt`), which silently
//   threw ReferenceError inside the existing try/catch in Phase 1c — so the
//   calendar cache refresh on every */15 cron tick was silently failing
//   in production.
//
//   Moving the state to this shared module makes the cross-module sharing
//   explicit, restores the original behavior, and preserves all KV/TTL/write
//   characteristics (this is in-memory isolate cache only; KV writes are
//   unchanged in worker-proxy.js).
// ═════════════════════════════════════════════════════════════════════════════

let _value = null;
let _ts = 0;

export function getCalendarIsolateCache() {
  return _value;
}

export function getCalendarIsolateCacheAt() {
  return _ts;
}

export function setCalendarIsolateCache(events, ts = Date.now()) {
  _value = events;
  _ts = ts;
}

/**
 * Notification Stale-Replica Suppression Test
 *
 * PROVEN RCA (2026-09-10, captured incident):
 *   - 12:46:13 — DELETE returns success on the primary (UPDATE deleted_at = NOW())
 *   - 12:46:58 — GET (44.7s later) returns the DELETED row from a stale read
 *                 replica. FRESH GET (not deduped), seq guard passed correctly.
 *                 Frontend re-applies the stale response → notification REAPPEARS.
 *   - 12:47:23 — GET (70s after DELETE) returns empty (replica caught up).
 *                 60s polling self-corrects the user's view.
 *
 * FIX (Option 1 — backend primary read, scoped):
 *   - notificationRepo.list / .unreadCount route through queryDbPrimary
 *     (Neon PRIMARY compute), NOT through queryDb (which may serve a stale
 *     replica).
 *   - DELETE / mutations continue to use queryDb (Hyperdrive/NeonPool) — the
 *     primary write path. The asymmetry (writes via existing path, reads via
 *     primary-direct neon()) guarantees read-after-write consistency.
 *
 * This test reproduces the RCA deterministically with simulated clock advance
 * and verifies that across the full 0–90s window after a DELETE, GET
 * /api/notifications NEVER returns the deleted row.
 *
 * Run: node --test notif-stale-replica-suppression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ────────────────────────────────────────────────────────────────────────────
// Load the real notification repository via source evaluation (the project
// is "type": "commonjs", but the repo file uses ESM `export function` syntax
// — Cloudflare's wrangler bundler handles this in production; Node's plain
// require() cannot. We strip the `export ` keyword and eval as CommonJS in a
// sandbox, mirroring notification-return-bug-test.cjs's approach.
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  const transformed = src.replace(/^export function createNotificationRepository\(/m, 'function createNotificationRepository(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console', 'AbortSignal',
    transformed + '\nmodule.exports.createNotificationRepository = createNotificationRepository;');
  const sandboxConsole = { warn: () => {}, log: () => {}, error: () => {} };
  const sandboxAbort = { timeout: () => null };
  wrapper(moduleObj, moduleObj.exports, globalThis, sandboxConsole, sandboxAbort);
  return moduleObj.exports.createNotificationRepository;
}

// ────────────────────────────────────────────────────────────────────────────
// Simulated database state with primary + replica.
//
// The "replica" lags the primary by a configurable interval (default 45s).
// Reads from queryDb go to the replica (simulating the production Hyperdrive
// config pointing at a read replica). Reads from queryDbPrimary go to the
// primary (immediately consistent). Writes from queryDb go to the primary.
// ────────────────────────────────────────────────────────────────────────────
function makeSimulatedDb({ replicaLagMs = 45000 } = {}) {
  const state = {
    // The "primary" authoritative state: Map<notifId, {row, deletedAt}>
    primary: new Map(),
    // The "replica" state with lag: Map<notifId, {row, deletedAt}> — updated
    // only after replicaLagMs has passed since the corresponding primary write.
    replica: new Map(),
    // Pending replica updates: [{ applyAt, fn }]
    pendingReplicaUpdates: [],
    clock: 0, // ms since start
  };

  function tickMs(ms) {
    state.clock += ms;
    const due = [];
    for (let i = state.pendingReplicaUpdates.length - 1; i >= 0; i--) {
      if (state.pendingReplicaUpdates[i].applyAt <= state.clock) {
        due.push(state.pendingReplicaUpdates[i]);
        state.pendingReplicaUpdates.splice(i, 1);
      }
    }
    // Apply in insertion order
    due.sort((a, b) => a.applyAt - b.applyAt);
    for (const d of due) d.fn();
  }

  // queryDb: writes go to primary immediately AND schedule a delayed replica
  // update. Reads (SELECT) come from the REPLICA (stale view) — this is what
  // simulates the production Hyperdrive config pointing at a read replica.
  const queryDb = async (env, sqlText, params = []) => {
    const sql = String(sqlText).replace(/\s+/g, ' ').trim();

    // SELECT list query (notificationRepo.list via queryDb — pre-fix / control)
    if (/^SELECT id, user_id, type, title, message, metadata, read_status, created_at FROM notifications WHERE user_id = \$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT \$2$/i.test(sql)) {
      const userId = String(params[0]);
      const limit = Number(params[1]);
      const rows = [];
      for (const [id, row] of state.replica) {  // ← REPLICA (stale view)
        if (row.user_id === userId && row.deletedAt == null) {
          rows.push({
            id, user_id: row.user_id, type: row.type, title: row.title,
            message: row.message, metadata: row.metadata, read_status: row.read_status,
            created_at: row.created_at,
          });
        }
      }
      rows.sort((a, b) => b.created_at - a.created_at);
      return { rows: rows.slice(0, limit), rowCount: rows.length, fields: [], command: 'SELECT' };
    }
    // SELECT COUNT (notificationRepo.unreadCount via queryDb — pre-fix / control)
    if (/^SELECT COUNT\(\*\)::int AS count FROM notifications WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL$/i.test(sql)) {
      const userId = String(params[0]);
      let count = 0;
      for (const [, row] of state.replica) {  // ← REPLICA (stale view)
        if (row.user_id === userId && row.read_status === false && row.deletedAt == null) count++;
      }
      return { rows: [{ count }], rowCount: 1, fields: [], command: 'SELECT' };
    }
    // UPDATE soft-delete single (deleteNotification)
    if (/^UPDATE notifications SET deleted_at = NOW\(\) WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL RETURNING id$/i.test(sql)) {
      const id = String(params[0]);
      const userId = String(params[1]);
      const row = state.primary.get(id);
      if (row && row.user_id === userId && row.deletedAt == null) {
        row.deletedAt = state.clock;
        state.pendingReplicaUpdates.push({
          applyAt: state.clock + replicaLagMs,
          fn: () => { if (state.replica.has(id)) state.replica.get(id).deletedAt = row.deletedAt; },
        });
        return { rows: [{ id }], rowCount: 1, fields: [], command: 'UPDATE' };
      }
      return { rows: [], rowCount: 0, fields: [], command: 'UPDATE' };
    }
    // UPDATE soft-delete all (deleteAll)
    if (/^UPDATE notifications SET deleted_at = NOW\(\) WHERE user_id = \$1 AND deleted_at IS NULL RETURNING id$/i.test(sql)) {
      const userId = String(params[0]);
      const deletedIds = [];
      for (const [id, row] of state.primary) {
        if (row.user_id === userId && row.deletedAt == null) {
          row.deletedAt = state.clock;
          deletedIds.push(id);
          state.pendingReplicaUpdates.push({
            applyAt: state.clock + replicaLagMs,
            fn: () => { if (state.replica.has(id)) state.replica.get(id).deletedAt = row.deletedAt; },
          });
        }
      }
      return { rows: deletedIds.map((id) => ({ id })), rowCount: deletedIds.length, fields: [], command: 'UPDATE' };
    }
    // UPDATE read_status single (markRead)
    if (/^UPDATE notifications SET read_status = TRUE WHERE id = \$1 AND user_id = \$2 RETURNING id$/i.test(sql)) {
      const id = String(params[0]);
      const userId = String(params[1]);
      const row = state.primary.get(id);
      if (row && row.user_id === userId) {
        row.read_status = true;
        state.pendingReplicaUpdates.push({
          applyAt: state.clock + replicaLagMs,
          fn: () => { if (state.replica.has(id)) state.replica.get(id).read_status = true; },
        });
        return { rows: [{ id }], rowCount: 1, fields: [], command: 'UPDATE' };
      }
      return { rows: [], rowCount: 0, fields: [], command: 'UPDATE' };
    }
    // UPDATE read_status all (markAllRead)
    if (/^UPDATE notifications SET read_status = TRUE WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL$/i.test(sql)) {
      const userId = String(params[0]);
      let count = 0;
      for (const [id, row] of state.primary) {
        if (row.user_id === userId && row.read_status === false && row.deletedAt == null) {
          row.read_status = true;
          count++;
          state.pendingReplicaUpdates.push({
            applyAt: state.clock + replicaLagMs,
            fn: () => { if (state.replica.has(id)) state.replica.get(id).read_status = true; },
          });
        }
      }
      return { rows: [], rowCount: count, fields: [], command: 'UPDATE' };
    }
    // CREATE TABLE / ALTER TABLE / CREATE INDEX — no-op in simulation
    if (/^CREATE (TABLE|INDEX)/i.test(sql) || /^ALTER TABLE/i.test(sql)) {
      return { rows: [], rowCount: 0, fields: [], command: 'DDL' };
    }
    // INSERT INTO notifications (for create / createBulk) — simulate as no-op success
    if (/^INSERT INTO notifications/i.test(sql)) {
      return { rows: [], rowCount: 1, fields: [], command: 'INSERT' };
    }
    // INSERT INTO notification_settings / SELECT FROM notification_settings — no-op
    if (/notification_settings/i.test(sql)) {
      return { rows: [], rowCount: 0, fields: [], command: 'OTHER' };
    }
    // Default
    return { rows: [], rowCount: 0, fields: [], command: 'NOOP' };
  };

  // queryDbPrimary: reads come from the PRIMARY (immediately consistent).
  // Writes should NOT come through queryDbPrimary (contract), but if they do,
  // we route them to the primary state and refuse unknown queries.
  const queryDbPrimary = async (env, sqlText, params = []) => {
    const sql = String(sqlText).replace(/\s+/g, ' ').trim();
    // SELECT list query
    if (/^SELECT id, user_id, type, title, message, metadata, read_status, created_at FROM notifications WHERE user_id = \$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT \$2$/i.test(sql)) {
      const userId = String(params[0]);
      const limit = Number(params[1]);
      const rows = [];
      for (const [id, row] of state.primary) {  // ← PRIMARY (consistent)
        if (row.user_id === userId && row.deletedAt == null) {
          rows.push({
            id, user_id: row.user_id, type: row.type, title: row.title,
            message: row.message, metadata: row.metadata, read_status: row.read_status,
            created_at: row.created_at,
          });
        }
      }
      rows.sort((a, b) => b.created_at - a.created_at);
      return { rows: rows.slice(0, limit), rowCount: rows.length, fields: [], command: 'SELECT' };
    }
    // SELECT COUNT
    if (/^SELECT COUNT\(\*\)::int AS count FROM notifications WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL$/i.test(sql)) {
      const userId = String(params[0]);
      let count = 0;
      for (const [, row] of state.primary) {  // ← PRIMARY (consistent)
        if (row.user_id === userId && row.read_status === false && row.deletedAt == null) count++;
      }
      return { rows: [{ count }], rowCount: 1, fields: [], command: 'SELECT' };
    }
    // Unknown query — refuse (so we'd notice if a mutation accidentally went
    // through queryDbPrimary, or if the simulation is missing a query pattern).
    throw new Error('[sim] queryDbPrimary received unknown query: ' + sql.slice(0, 120));
  };

  // Seed: add a notification to BOTH primary and replica (as if it had been
  // created long ago — both are in sync at clock=0).
  function seedNotification({ id, userId, type = 'system', title = 'T', message = 'M', read_status = false, created_at = 0 }) {
    const row = { user_id: userId, type, title, message, metadata: null, read_status, created_at, deletedAt: null };
    state.primary.set(id, { ...row });
    state.replica.set(id, { ...row });
  }

  return { state, tickMs, queryDb, queryDbPrimary, seedNotification };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('RCA repro WITHOUT fix: GET via queryDb returns deleted row from stale replica (sanity)', async () => {
  // This test confirms the simulation actually reproduces the bug WHEN the
  // repository reads through queryDb (the pre-fix behavior). It is the control
  // for the suppression test below.
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000 });
  // Pre-fix repo: list() routes through queryDb (we monkey-patch by
  // constructing a repo where queryDbPrimary === queryDb — same path).
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDb });
  // DELETE at t=5000
  sim.tickMs(5000);
  const del = await repo.deleteNotification({}, 'N1', 'user-1');
  assert.equal(del, true, 'delete must succeed on primary');
  // GET at t=5000+20000 (still within replica lag) → replica still shows N1
  sim.tickMs(20000);
  // Force list() to use queryDb (not queryDbPrimary) for this control test
  const repoPreFix = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDb });
  const listPreFix = await repoPreFix.list({}, 'user-1', 50);
  // Control test: when list reads from replica (because queryDbPrimary==queryDb),
  // the deleted N1 IS returned — this is the bug. This proves the simulation
  // reproduces the RCA.
  const foundN1 = listPreFix.find((n) => n.id === 'N1');
  assert.ok(foundN1, 'CONTROL: pre-fix list reads stale replica and returns deleted N1 — confirms simulation reproduces RCA');
});

test('RCA repro WITH fix: GET via queryDbPrimary NEVER returns deleted row across 0–90s window', async () => {
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000 });
  sim.seedNotification({ id: 'N2', userId: 'user-1', created_at: 2000 });
  // FIXED repo: list() and unreadCount() use queryDbPrimary (primary-direct).
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDbPrimary });

  // Pre-DELETE: list shows both N1 and N2
  sim.tickMs(5000);
  const before = await repo.list({}, 'user-1', 50);
  assert.equal(before.length, 2, 'pre-delete list shows both notifications');
  assert.ok(before.find((n) => n.id === 'N1'));
  assert.ok(before.find((n) => n.id === 'N2'));
  const unreadBefore = await repo.unreadCount({}, 'user-1');
  assert.equal(unreadBefore, 2, 'pre-delete unreadCount = 2');

  // DELETE N1 at t=5000 (commits on primary; replica lags by 45s)
  const del = await repo.deleteNotification({}, 'N1', 'user-1');
  assert.equal(del, true, 'delete must succeed on primary');

  // Verify replica is STILL stale immediately after delete (control check:
  // the simulation's replica lag is real)
  const replicaStillStale = [];
  for (const [id, row] of sim.state.replica) if (id === 'N1') replicaStillStale.push(row);
  assert.equal(replicaStillStale[0].deletedAt, null, 'control: replica has NOT yet applied the delete (lag still active)');

  // Sample GET at multiple points across the 0–90s window — none should return N1.
  const samplePoints = [
    0,    // immediately after DELETE (replica at peak staleness)
    5000,
    15000,
    30000,
    44000, // just before replica catch-up
    45000, // replica catches up
    50000,
    60000, // 60s polling cycle
    70000, // RCA self-correction point
    90000, // well beyond
  ];
  let prevClock = 5000;
  for (const t of samplePoints) {
    const advance = t - (prevClock - 5000);
    sim.tickMs(advance);
    prevClock = 5000 + t;
    const list = await repo.list({}, 'user-1', 50);
    const unread = await repo.unreadCount({}, 'user-1');
    const foundN1 = list.find((n) => n.id === 'N1');
    assert.equal(foundN1, undefined, `FIX: list at t=${t}ms post-DELETE must NOT return deleted N1`);
    assert.equal(list.length, 1, `FIX: list at t=${t}ms must show only N2 (N1 deleted)`);
    assert.ok(list.find((n) => n.id === 'N2'), `FIX: list at t=${t}ms must still show N2`);
    assert.ok(unread <= 1, `FIX: unreadCount at t=${t}ms must not count deleted N1 (got ${unread})`);
  }
});

test('RCA repro WITH fix: badge count (unreadCount) NEVER includes deleted row across 0–90s window', async () => {
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000, read_status: false });
  sim.seedNotification({ id: 'N2', userId: 'user-1', created_at: 2000, read_status: false });
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDbPrimary });
  sim.tickMs(5000);
  await repo.deleteNotification({}, 'N1', 'user-1');
  const samplePoints = [0, 5000, 20000, 30000, 44999, 45000, 50000, 60000, 70000, 90000];
  let prevClock = 5000;
  for (const t of samplePoints) {
    const advance = t - (prevClock - 5000);
    sim.tickMs(advance);
    prevClock = 5000 + t;
    const unread = await repo.unreadCount({}, 'user-1');
    assert.equal(unread, 1, `FIX: unreadCount at t=${t}ms post-DELETE = 1 (N2 only, never N1) — got ${unread}`);
  }
});

test('RCA repro WITH fix: clearAll (deleteAll) + subsequent GET never returns deleted rows', async () => {
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000 });
  sim.seedNotification({ id: 'N2', userId: 'user-1', created_at: 2000 });
  sim.seedNotification({ id: 'N3', userId: 'user-1', created_at: 3000 });
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDbPrimary });
  sim.tickMs(5000);
  const deletedCount = await repo.deleteAll({}, 'user-1');
  assert.equal(deletedCount, 3, 'deleteAll must soft-delete all 3 rows on primary');
  // Verify replica is stale
  assert.equal(sim.state.replica.get('N1').deletedAt, null, 'replica N1 still stale');
  assert.equal(sim.state.replica.get('N2').deletedAt, null, 'replica N2 still stale');
  assert.equal(sim.state.replica.get('N3').deletedAt, null, 'replica N3 still stale');
  const samplePoints = [0, 10000, 30000, 44999, 45000, 60000, 90000];
  let prevClock = 5000;
  for (const t of samplePoints) {
    const advance = t - (prevClock - 5000);
    sim.tickMs(advance);
    prevClock = 5000 + t;
    const list = await repo.list({}, 'user-1', 50);
    const unread = await repo.unreadCount({}, 'user-1');
    assert.equal(list.length, 0, `FIX: list at t=${t}ms after clearAll = 0`);
    assert.equal(unread, 0, `FIX: unreadCount at t=${t}ms after clearAll = 0`);
  }
});

test('RCA repro WITH fix: markRead (state change) + subsequent GET sees consistent read_status from primary', async () => {
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000, read_status: false });
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDbPrimary });
  sim.tickMs(5000);
  // markRead goes through queryDb (mutation path) → updates primary immediately,
  // replica lags.
  const ok = await repo.markRead({}, 'N1', 'user-1');
  assert.equal(ok, true, 'markRead must succeed on primary');
  // Verify replica is stale (still unread)
  assert.equal(sim.state.replica.get('N1').read_status, false, 'replica N1 still has stale read_status=false');
  // GET via queryDbPrimary should immediately reflect read_status=true.
  const list = await repo.list({}, 'user-1', 50);
  assert.equal(list.length, 1, 'list shows N1');
  assert.equal(list[0].read, true, 'FIX: list via queryDbPrimary reflects primary read_status=true immediately (replica lag bypassed)');
  const unread = await repo.unreadCount({}, 'user-1');
  assert.equal(unread, 0, 'FIX: unreadCount via queryDbPrimary = 0 immediately after markRead');
});

test('RCA repro WITH fix: mutation path (queryDb) is NEVER used for notification reads', async () => {
  const createNotificationRepository = loadRepo();
  let queryDbCalls = 0;
  let queryDbPrimaryCalls = 0;
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000 });
  const wrappedQueryDb = async (env, sqlText, params) => {
    queryDbCalls++;
    return sim.queryDb(env, sqlText, params);
  };
  const wrappedQueryDbPrimary = async (env, sqlText, params) => {
    queryDbPrimaryCalls++;
    return sim.queryDbPrimary(env, sqlText, params);
  };
  const repo = createNotificationRepository({ queryDb: wrappedQueryDb, queryDbPrimary: wrappedQueryDbPrimary });
  sim.tickMs(5000);
  await repo.deleteNotification({}, 'N1', 'user-1');   // mutation → queryDb
  // Read path (multiple times to simulate polling)
  await repo.list({}, 'user-1');
  await repo.unreadCount({}, 'user-1');
  await repo.list({}, 'user-1');
  await repo.unreadCount({}, 'user-1');
  // queryDb was called: ensureTable (first call to any method triggers it) + deleteNotification
  // queryDbPrimary was called: 2 list + 2 unreadCount = 4
  assert.ok(queryDbPrimaryCalls === 4, `queryDbPrimary called ${queryDbPrimaryCalls} times (expected 4: 2 list + 2 unreadCount)`);
  // queryDb must have been called for the delete mutation AND NOT for any read.
  // (ensureTable may or may not run depending on the order; it's also routed via queryDb.)
  assert.ok(queryDbCalls >= 1, `queryDb called for delete mutation (got ${queryDbCalls})`);
});

test('RCA repro WITH fix: simulating 60s frontend poll — every GET returns primary-consistent state', async () => {
  const createNotificationRepository = loadRepo();
  const sim = makeSimulatedDb({ replicaLagMs: 45000 });
  sim.seedNotification({ id: 'N1', userId: 'user-1', created_at: 1000 });
  const repo = createNotificationRepository({ queryDb: sim.queryDb, queryDbPrimary: sim.queryDbPrimary });
  sim.tickMs(5000);
  await repo.deleteNotification({}, 'N1', 'user-1');
  // Simulate 3 polling cycles at 60s intervals, each invoking list + unreadCount
  for (let cycle = 0; cycle < 3; cycle++) {
    sim.tickMs(60000);
    const list = await repo.list({}, 'user-1', 50);
    const unread = await repo.unreadCount({}, 'user-1');
    assert.equal(list.length, 0, `poll cycle ${cycle}: list = 0 (deleted N1 never reappears)`);
    assert.equal(unread, 0, `poll cycle ${cycle}: unreadCount = 0`);
  }
});

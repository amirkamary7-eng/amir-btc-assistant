/**
 * MAINTENANCE AUTO-NOTIFICATIONS — REGRESSION TEST (behavioral)
 * ==============================================================
 * Locks the maintenance start/end auto-notification feature:
 *
 *   MNT-01  True disabled→enabled transition ⇒ exactly ONE start broadcast.
 *   MNT-02  Mid-maintenance edits (title/description/progress/re-enable)
 *           NEVER mint a new period (no duplicate start).
 *   MNT-03  End of period while service unhealthy ⇒ NO recovery broadcast
 *           (health errors can never cause a false "restored").
 *   MNT-04  End after confirmed health ⇒ exactly ONE broadcast; repeated
 *           ticks are no-ops.
 *   MNT-05  Concurrent inserts + repeated cron runs ⇒ no duplicate rows —
 *           the insert is ONE atomic statement (INSERT…SELECT…WHERE NOT
 *           EXISTS…RETURNING), never SELECT-then-INSERT.
 *   MNT-06  Worker restart (fresh isolate, same KV) preserves state and
 *           period_id; the new isolate cannot re-notify.
 *   MNT-07  Custom texts load/save with safe defaults for empty/oversized;
 *           PUT merge semantics touch only the provided field.
 *   MNT-08  Non-admins cannot read/write the texts (401/403); admin can.
 *   MNT-09  Queue/retry path respected: processBroadcastFull is enqueue-only
 *           (sendTelegramMessageFn NEVER invoked); force_channel delivers
 *           to BOTH channels for every target user (maintenance = critical
 *           system notice), including users whose normal preference is
 *           mini_app / none.
 *   MNT-10  Legacy broadcasts (no force_channel flag) keep the exact
 *           previous preference-driven behavior.
 *   MNT-11  Cron wiring: 5-min scheduler runs the tick; scheduled() passes
 *           the dependency.
 *   MNT-12  Admin PUT hook: start notification scheduled via backgroundTask
 *           ONLY on the real transition (prev-state snapshot).
 *   MNT-13  UI wiring: the settings live in the SYSTEM-CONTROLS
 *           (maintenance) section — next to the Maintenance Mode card —
 *           NOT in the notification center or advertisements; fields +
 *           preview + per-field save + i18n keys fa/en.
 *   MNT-14  Start-insert recovery: if the inline insert died with its
 *           isolate, the cron tick re-inserts it (exactly once).
 *   MNT-16  Audience: target_all_users broadcasts select the FULL users
 *           table (no channel_joined filter) — premium/free/non-member
 *           equal; legacy broadcasts keep the channel_joined=TRUE filter.
 *   MNT-17  Bot-blocked / invalid-id users: bounded queue retries capped at
 *           max_attempts → terminal 'failed' — never an infinite retry loop.
 *   MNT-18  Relocated editor behaves end-to-end in the system-controls
 *           section: render, live preview, per-field save WITHOUT clobbering
 *           the other field.
 *   MNT-19  force_channel / target_all_users are set ONLY by the maintenance
 *           feature (never by legacy notification paths).
 *
 * Behavioral harness: the REAL maintenance region and the REAL repo
 * functions are extracted from source and executed in vm sandboxes with
 * KV / DB / fetch stubs. A controllable Date makes period-id determinism
 * testable across minute boundaries.
 *
 * All tests are offline. Run: node --test tests/maintenance-auto-notif-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const WORKER_SRC = read('worker-proxy.js');
const NP_SRC = read('src/repositories/notification_platform.js');
const SCHED_SRC = read('src/cron/scheduler.js');
const ADMIN_SRC = read('admin.js');
const HTML = read('index.html');
const I18N_SRC = read('i18n.js');
const CSS_SRC = read('style.css');

// ── Extraction helpers ─────────────────────────────────────────────────────

// The whole maintenance region (state + notifications) between the KV key
// constant and the MAINT-NOTIF end marker — one contiguous, self-contained
// block (module-level lets for the in-memory fallback live inside it).
const MAINT_REGION = (() => {
  const s = WORKER_SRC.indexOf('const MAINT_KV_KEY');
  const e = WORKER_SRC.indexOf('// [MAINT-NOTIF-END]');
  assert.ok(s !== -1 && e !== -1, 'maintenance region markers found');
  return WORKER_SRC.slice(s, e + '// [MAINT-NOTIF-END]'.length);
})();

// The notif-texts admin route block (an `if (...) { ... return ... }` block).
const MAINT_ROUTE = (() => {
  const s = WORKER_SRC.indexOf('// [MAINT-NOTIF-ROUTE-START]');
  const e = WORKER_SRC.indexOf('// [MAINT-NOTIF-ROUTE-END]');
  assert.ok(s !== -1 && e !== -1, 'maintenance route markers found');
  const afterStart = WORKER_SRC.indexOf('\n', s) + 1;
  return WORKER_SRC.slice(afterStart, e);
})();

// String-search + brace-counting function extraction (works for both
// column-0 declarations in admin.js and indented ones inside the
// notification_platform.js factory — braces in the extracted bodies are
// balanced by construction, the files are valid JS).
function extractFn(src, name, isAsync) {
  const needle = `${isAsync ? 'async ' : ''}function ${name}(`;
  const start = src.indexOf(needle);
  if (start === -1) throw new Error(`Function ${name} not found`);
  // Skip the parameter list FIRST (params may contain destructured braces —
  // e.g. createDedupBroadcast(env, { ...opts }, pool = null) — which must
  // NOT be mistaken for the function body).
  const paramsEnd = src.indexOf(')', start);
  const open = src.indexOf('{', paramsEnd);
  assert.ok(paramsEnd !== -1 && open > paramsEnd, `bad signature for ${name}`);
  let depth = 0;
  let j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`Function ${name} braces unbalanced`);
  return src.slice(start, j + 1);
}

const PROCESS_BROADCAST_FULL_SRC = extractFn(NP_SRC, 'processBroadcastFull', true);
const GET_CHANNEL_COLUMN_SRC = extractFn(NP_SRC, '_getChannelColumn', false);
const CREATE_DEDUP_BROADCAST_SRC = extractFn(NP_SRC, 'createDedupBroadcast', true);
const PROCESS_QUEUE_SRC = extractFn(NP_SRC, 'processQueue', true);

// ── Sandbox factory ────────────────────────────────────────────────────────

/**
 * Executes the REAL maintenance region in a fresh vm context.
 * opts:
 *   kv           — shared Map acting as APP_CACHE (survives "restarts")
 *   nowRef       — { v: ms } controllable clock (period-id determinism)
 *   queryDb      — stub for queryDb
 *   appContentRepo — stub { getContent, updateContent }
 *   npRepo       — stub { createDedupBroadcast, processBroadcastFull }
 *   fetchImpl    — stub for global fetch (health getMe)
 *   dbConfigured / botConfigured — booleans for the guards
 */
function makeMaintSandbox(opts = {}) {
  const kv = opts.kv || new Map();
  const nowRef = opts.nowRef || { v: Date.UTC(2026, 9, 15, 6, 30, 0) };
  const calls = { queries: [], inserts: [], drains: [], sends: [], fetches: [], logs: [] };
  const env = {
    APP_CACHE: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
    TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
    ctx: null,
  };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(nowRef.v); else super(...a); }
    static now() { return nowRef.v; }
  }
  const sandbox = {
    console: { log: (...a) => { calls.logs.push(a.join(' ')); }, warn: () => {}, error: () => {} },
    queryDb: opts.queryDb || (async (e, sql, params) => { calls.queries.push({ sql, params }); return { rows: [] }; }),
    appContentRepo: opts.appContentRepo || { getContent: async () => null, updateContent: async () => ({}) },
    notificationPlatformRepo: opts.npRepo || {
      createDedupBroadcast: async (e, data, pool) => { calls.inserts.push(data); return calls.inserts.length === 1 ? 101 : null; },
      processBroadcastFull: async (e, fn, id, pool) => { calls.drains.push(id); return { processed: 0 }; },
    },
    sendTelegramMessage: async (...a) => { calls.sends.push(a); return { ok: true, messageId: 1 }; },
    isDatabaseConfigured: () => opts.dbConfigured !== false,
    isBotConfigured: () => opts.botConfigured !== false,
    buildTelegramApiUrl: (e, m) => 'https://api.telegram.org/botTEST/' + m,
    fetch: opts.fetchImpl || (async (url) => { calls.fetches.push(String(url)); return { ok: true, json: async () => ({ ok: true, result: { id: 42 } }) }; }),
    setTimeout, clearTimeout, AbortController,
    Date: FakeDate,
  };
  vm.createContext(sandbox);
  vm.runInContext(MAINT_REGION, sandbox, { filename: 'worker-proxy.js#maint-region' });
  return { sandbox, env, kv, calls, nowRef };
}

// Fake queryDb implementing the WHERE NOT EXISTS semantics of
// createDedupBroadcast's single-statement INSERT (serialized in JS — the DB
// serializes the real one).
function makeAtomicDb() {
  const db = { broadcastRows: [] };
  const seen = [];
  const queryDb = async (env, sql, params) => {
    seen.push({ sql: sql.trim(), params });
    if (sql.includes('INSERT INTO notification_broadcasts') && sql.includes('WHERE NOT EXISTS') && sql.includes('RETURNING id')) {
      const dedupKey = params[8];
      const exists = db.broadcastRows.some((r) => r.metadata.dedup_key === dedupKey);
      if (exists) return { rows: [] };
      const id = db.broadcastRows.length + 1;
      db.broadcastRows.push({ id, admin_id: params[0], metadata: JSON.parse(params[7]) });
      return { rows: [{ id }] };
    }
    throw new Error('unexpected SQL in atomic db: ' + sql.slice(0, 60));
  };
  return { db, queryDb, seen };
}

// ═══════════════════════════════════════════════════════════════════════════
// MNT-01 / MNT-02 — period identity + start notification
// ═══════════════════════════════════════════════════════════════════════════

test('MNT-01: true disabled→enabled transition mints a period and inserts EXACTLY ONE start broadcast', async () => {
  const m = makeMaintSandbox();
  const before = await m.sandbox.getMaintenanceState(m.env);
  assert.equal(before.maintenance.enabled, false, 'starts disabled');
  assert.equal(before.maintenance.period_id, null, 'no period initially');

  const r1 = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  assert.equal(r1.maintenance.enabled, true);
  assert.match(r1.maintenance.period_id, /^maint_\d{8}T\d{4}Z$/, 'deterministic period id');

  const res = await m.sandbox.maintenanceStartNotification(m.env, 'admin-1', r1.maintenance.period_id);
  assert.equal(res.status, 'inserted', 'first call inserts');
  assert.equal(m.calls.inserts.length, 1, 'exactly one broadcast insert');
  assert.equal(m.calls.inserts[0].metadata.maintenance_kind, 'start');
  assert.equal(m.calls.inserts[0].metadata.dedup_key, 'maint_start_' + r1.maintenance.period_id);
  assert.equal(m.calls.inserts[0].metadata.force_channel, true, 'critical system notice forces both channels');
  assert.equal(m.calls.inserts[0].priority, 'high');
  assert.equal(m.calls.inserts[0].adminId, 'admin-1');
  assert.equal(m.calls.drains.length, 1, 'immediate enqueue drain via processBroadcastFull');
  assert.equal(m.calls.sends.length, 0, 'NEVER sends Telegram directly (queue-only)');

  // Second invocation (retry / double-click / cron overlap): dedup stub
  // returns null (row already exists) ⇒ already-notified, no second drain.
  const res2 = await m.sandbox.maintenanceStartNotification(m.env, 'admin-1', r1.maintenance.period_id);
  assert.equal(res2.status, 'already-notified');
  assert.equal(m.calls.drains.length, 1, 'no second drain');
});

test('MNT-02: mid-maintenance edits NEVER create a new period', async () => {
  const m = makeMaintSandbox();
  const r1 = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  const P = r1.maintenance.period_id;

  // Title / description / progress edits while enabled.
  const r2 = await m.sandbox.setMaintenanceState(m.env, { title: 'عنوان جدید', progress: 40 }, 'admin-1');
  assert.equal(r2.maintenance.period_id, P, 'title/progress edit keeps the period');
  assert.equal(r2.maintenance.title, 'عنوان جدید');
  assert.equal(r2.maintenance.progress, 40);

  // Re-asserting enabled:true while ALREADY enabled — still the same period.
  const r3 = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  assert.equal(r3.maintenance.period_id, P, 're-enable while enabled keeps the period');

  // Disable keeps the id too (the end detector needs it).
  const r4 = await m.sandbox.setMaintenanceState(m.env, { enabled: false }, 'admin-1');
  assert.equal(r4.maintenance.enabled, false);
  assert.equal(r4.maintenance.period_id, P, 'disable RETAINS the period id for the end notification');

  // A genuine NEW period (a minute later) gets a fresh id.
  m.nowRef.v += 60 * 1000;
  const r5 = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  assert.notEqual(r5.maintenance.period_id, P, 're-enable after a real gap ⇒ new period');
  assert.match(r5.maintenance.period_id, /^maint_\d{8}T\d{4}Z$/);

  // Sub-minute churn collapses into the same period (no notification storm).
  const r6 = await m.sandbox.setMaintenanceState(m.env, { enabled: false }, 'admin-1');
  const r7 = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  assert.equal(r7.maintenance.period_id, r5.maintenance.period_id, 'same-minute disable+enable collapses');
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-03 / MNT-04 / MNT-14 — the 5-min cron tick (end detector + recovery)
// ═══════════════════════════════════════════════════════════════════════════

function seedPeriodEnded(m) {
  return m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1')
    .then((r) => m.sandbox.setMaintenanceState(m.env, { enabled: false }, 'admin-1').then(() => r.maintenance.period_id));
}

test('MNT-03: unhealthy service ⇒ NO recovery broadcast, and the tick stays idempotent', async () => {
  // (a) PostgreSQL down (SELECT 1 throws)
  {
    const m = makeMaintSandbox({
      queryDb: async () => { throw new Error('connection refused'); },
    });
    const P = await seedPeriodEnded(m);
    const res = await m.sandbox.maintenanceNotificationTick(m.env);
    assert.equal(res.status, 'deferred-unhealthy');
    assert.equal(m.calls.inserts.length, 0, 'no broadcast while unhealthy');
  }
  // (b) Telegram getMe returns ok:false
  {
    const m = makeMaintSandbox({
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, description: 'Unauthorized' }) }),
    });
    const P = await seedPeriodEnded(m);
    const res = await m.sandbox.maintenanceNotificationTick(m.env);
    assert.equal(res.status, 'deferred-unhealthy');
    assert.equal(m.calls.inserts.length, 0);
  }
  // (c) Telegram getMe HTTP error
  {
    const m = makeMaintSandbox({
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    });
    const P = await seedPeriodEnded(m);
    const res = await m.sandbox.maintenanceNotificationTick(m.env);
    assert.equal(res.status, 'deferred-unhealthy');
    assert.equal(m.calls.inserts.length, 0);
  }
  // (d) bot not configured
  {
    const m = makeMaintSandbox({ botConfigured: false });
    const P = await seedPeriodEnded(m);
    const res = await m.sandbox.maintenanceNotificationTick(m.env);
    assert.equal(res.status, 'skipped');
    assert.equal(m.calls.inserts.length, 0);
  }
});

test('MNT-04: healthy service ⇒ exactly ONE end broadcast; repeated ticks are no-ops', async () => {
  const m = makeMaintSandbox(); // default health stub: DB ok + getMe ok
  const P = await seedPeriodEnded(m);

  const res1 = await m.sandbox.maintenanceNotificationTick(m.env);
  assert.equal(res1.status, 'end-inserted', 'first healthy tick inserts the end broadcast');
  assert.equal(m.calls.inserts.length, 1);
  assert.equal(m.calls.inserts[0].metadata.maintenance_kind, 'end');
  assert.equal(m.calls.inserts[0].metadata.dedup_key, 'maint_end_' + P);
  assert.equal(m.calls.inserts[0].adminId, 'system');

  // Health IS re-checked only until the broadcast exists; simulate the
  // existing row via the fast-path query (the default queryDb returns no
  // rows — so stub the second tick's queryDb to report existence).
  let exists = false;
  const m2 = makeMaintSandbox({
    kv: m.kv,
    queryDb: async (e, sql, params) => {
      if (sql.includes('SELECT 1 FROM notification_broadcasts')) {
        return { rows: exists ? [{ one: 1 }] : [] };
      }
      return { rows: [] };
    },
  });
  exists = true;
  const res2 = await m2.sandbox.maintenanceNotificationTick(m2.env);
  assert.equal(res2.status, 'end-already', 'second tick recognizes the existing broadcast');
  assert.equal(m2.calls.inserts.length, 0, 'no duplicate insert');
  assert.equal(m2.calls.fetches.length, 0, 'health is not even re-probed once the row exists');
});

test('MNT-14: start-insert recovery — cron tick re-inserts a missing start broadcast exactly once', async () => {
  let startExists = false;
  const m = makeMaintSandbox({
    queryDb: async (e, sql, params) => {
      if (sql.includes('SELECT 1 FROM notification_broadcasts')) {
        return { rows: startExists ? [{ one: 1 }] : [] };
      }
      return { rows: [] };
    },
  });
  const r = await m.sandbox.setMaintenanceState(m.env, { enabled: true }, 'admin-1');
  const P = r.maintenance.period_id;

  // Inline insert "died with the isolate" (no broadcast row): tick recovers.
  const res1 = await m.sandbox.maintenanceNotificationTick(m.env);
  assert.equal(res1.status, 'start-recovered');
  assert.equal(m.calls.inserts.length, 1);
  assert.equal(m.calls.inserts[0].metadata.dedup_key, 'maint_start_' + P);

  // Next tick: row now exists ⇒ no-op.
  startExists = true;
  const res2 = await m.sandbox.maintenanceNotificationTick(m.env);
  assert.equal(res2.status, 'start-already');
  assert.equal(m.calls.inserts.length, 1, 'still exactly one start broadcast');
});

test('MNT-idle: no period (legacy state / never enabled) ⇒ tick idles without any insert', async () => {
  const m = makeMaintSandbox();
  const res = await m.sandbox.maintenanceNotificationTick(m.env);
  assert.equal(res.status, 'idle');
  assert.equal(m.calls.inserts.length, 0);
  assert.equal(m.calls.fetches.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-05 / MNT-06 — atomicity, concurrency, restart
// ═══════════════════════════════════════════════════════════════════════════

test('MNT-05: concurrent callers race through the REAL atomic insert ⇒ exactly one row (no SELECT-then-INSERT)', async () => {
  const { db, queryDb, seen } = makeAtomicDb();
  const sandbox = { console: { warn: () => {} }, isDatabaseConfigured: () => true, queryDb };
  vm.createContext(sandbox);
  vm.runInContext(CREATE_DEDUP_BROADCAST_SRC, sandbox, { filename: 'np.js#createDedupBroadcast' });
  const mk = (adminId) => sandbox.createDedupBroadcast(
    { env: true },
    {
      adminId,
      title: 't', message: 'm', category: 'system', priority: 'high',
      channel: 'both', target_type: 'all',
      metadata: { maintenance_period_id: 'maint_X', maintenance_kind: 'end', force_channel: true, dedup_key: 'maint_end_maint_X' },
    },
    null
  );
  const results = await Promise.all([mk('cron-a'), mk('cron-b'), mk('cron-c')]);
  const winners = results.filter((id) => id != null);
  assert.equal(winners.length, 1, 'exactly ONE concurrent caller wins the insert');
  assert.equal(db.broadcastRows.length, 1, 'exactly one row in the table');

  // The atomicity contract: a SINGLE statement containing the NOT EXISTS
  // guard inside the INSERT itself (never a separate SELECT followed by a
  // separate INSERT — that pattern races).
  const insertCalls = seen.filter((q) => q.sql.startsWith('INSERT INTO notification_broadcasts'));
  const selectCalls = seen.filter((q) => /^SELECT/.test(q.sql));
  assert.equal(insertCalls.length, 3, 'each caller issued its INSERT');
  assert.equal(selectCalls.length, 0, 'ZERO standalone SELECTs — the guard lives INSIDE the INSERT');
  for (const q of insertCalls) {
    assert.ok(q.sql.includes('WHERE NOT EXISTS'), 'NOT EXISTS predicate embedded in the INSERT');
    assert.ok(q.sql.includes('RETURNING id'), 'RETURNING id — the loser gets no row');
  }

  // A later (sequential) retry for the same event is a clean no-op.
  const again = await sandbox.createDedupBroadcast(
    { env: true },
    {
      adminId: 'cron-d', title: 't', message: 'm', category: 'system', priority: 'high',
      channel: 'both', target_type: 'all',
      metadata: { maintenance_period_id: 'maint_X', maintenance_kind: 'end', force_channel: true, dedup_key: 'maint_end_maint_X' },
    },
    null
  );
  assert.equal(again, null, 'duplicate insert returns null');
  assert.equal(db.broadcastRows.length, 1, 'still exactly one row');
});

test('MNT-06: worker restart (fresh isolate, same KV) preserves state + period and cannot re-notify', async () => {
  const sharedKv = new Map();
  const m1 = makeMaintSandbox({ kv: sharedKv });
  const r1 = await m1.sandbox.setMaintenanceState(m1.env, { enabled: true }, 'admin-1');
  const P = r1.maintenance.period_id;
  await m1.sandbox.setMaintenanceState(m1.env, { enabled: false }, 'admin-1');

  // "Restart": brand-new module state (fresh _maintMemoryState), SAME KV.
  let endExists = false;
  const m2 = makeMaintSandbox({
    kv: sharedKv,
    queryDb: async (e, sql) => {
      if (sql.includes('SELECT 1 FROM notification_broadcasts')) {
        return { rows: endExists ? [{ one: 1 }] : [] };
      }
      return { rows: [] };
    },
  });
  const state2 = await m2.sandbox.getMaintenanceState(m2.env);
  assert.equal(state2.maintenance.enabled, false, 'state survives the restart');
  assert.equal(state2.maintenance.period_id, P, 'period id survives the restart');

  const res = await m2.sandbox.maintenanceNotificationTick(m2.env);
  assert.equal(res.status, 'end-inserted', 'the end notification fires for the SAME period after restart');
  assert.equal(m2.calls.inserts[0].metadata.dedup_key, 'maint_end_' + P);

  // Third isolate after the broadcast exists: no duplicate, no health probe.
  endExists = true;
  const m3 = makeMaintSandbox({
    kv: sharedKv,
    queryDb: async (e, sql) => {
      if (sql.includes('SELECT 1 FROM notification_broadcasts')) {
        return { rows: [{ one: 1 }] };
      }
      return { rows: [] };
    },
  });
  const res3 = await m3.sandbox.maintenanceNotificationTick(m3.env);
  assert.equal(res3.status, 'end-already');
  assert.equal(m3.calls.inserts.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-07 / MNT-08 — texts storage + admin route (behavioral via route block)
// ═══════════════════════════════════════════════════════════════════════════

test('MNT-07: custom texts load with safe defaults for missing/empty/oversized values', async () => {
  // (a) No row at all ⇒ defaults + flags.
  {
    const m = makeMaintSandbox();
    const texts = await m.sandbox.getMaintenanceNotificationTexts(m.env);
    assert.equal(texts.start_is_default, true);
    assert.equal(texts.end_is_default, true);
    assert.ok(texts.start.includes('AMIRBTC'), 'default start text present');
    assert.ok(texts.end.includes('بازگشت به سرویس'), 'default end text present');
    assert.ok(texts.start.length <= 4000 && texts.end.length <= 4000, 'defaults within the Telegram budget');
  }
  // (b) Custom texts stored ⇒ effective + not-default flags.
  {
    const m = makeMaintSandbox({
      appContentRepo: {
        getContent: async () => ({
          sections: [
            { heading: 'start_message', body: '  شروع سفارشی  \nبدنه شروع' },
            { heading: 'end_message', body: 'پایان سفارشی' },
          ],
        }),
        updateContent: async () => ({}),
      },
    });
    const texts = await m.sandbox.getMaintenanceNotificationTexts(m.env);
    assert.equal(texts.start, 'شروع سفارشی  \nبدنه شروع'.trim(), 'custom start (trimmed) wins');
    assert.equal(texts.end, 'پایان سفارشی');
    assert.equal(texts.start_is_default, false);
    assert.equal(texts.end_is_default, false);
  }
  // (c) Oversized (> 4000) ⇒ INVALID ⇒ default for that field.
  {
    const m = makeMaintSandbox({
      appContentRepo: {
        getContent: async () => ({ sections: [{ heading: 'start_message', body: 'x'.repeat(4001) }] }),
        updateContent: async () => ({}),
      },
    });
    const texts = await m.sandbox.getMaintenanceNotificationTexts(m.env);
    assert.equal(texts.start_is_default, true, 'oversized custom start falls back to the default');
    assert.equal(texts.end_is_default, true);
  }
  // (d) Repo throws ⇒ defaults (send path never breaks).
  {
    const m = makeMaintSandbox({
      appContentRepo: {
        getContent: async () => { throw new Error('db down'); },
        updateContent: async () => ({}),
      },
    });
    const texts = await m.sandbox.getMaintenanceNotificationTexts(m.env);
    assert.equal(texts.start_is_default, true);
    assert.ok(texts.start.length > 0);
  }
  // (e) _maintSplitText: first line = title, remainder = message.
  {
    const m = makeMaintSandbox();
    const s1 = m.sandbox._maintSplitText('عنوان\nبدنه خط اول\nبدنه خط دوم');
    assert.equal(s1.title, 'عنوان');
    assert.equal(s1.message, 'بدنه خط اول\nبدنه خط دوم');
    const s2 = m.sandbox._maintSplitText('فقط یک خط');
    assert.equal(s2.title, 'فقط یک خط');
    assert.equal(s2.message, '');
    const s3 = m.sandbox._maintSplitText('   \n  \nبدنه');
    assert.equal(s3.title, 'بدنه', 'leading blank lines are skipped — first real line becomes the title');
    assert.equal(s3.message, '');
  }
});

/**
 * Execute the REAL notif-texts route block with injectable auth/db stubs.
 * Returns the route's return value (jsonResponse stub shape) + call log.
 */
async function runMaintRoute({ method, auth, isAdmin, stored, payload }) {
  const calls = { updateContent: [], saved: [] };
  const jsonResponse = (body, init = {}) => ({ __status: init.status || 200, ...body });
  const sandbox = {
    url: { pathname: '/api/admin/maintenance/notif-texts', searchParams: new URLSearchParams() },
    request: { method },
    env: { env: true },
    authenticateTelegramRequest: async () => auth,
    isAdminTelegramId: () => isAdmin,
    isDatabaseConfigured: () => true,
    jsonResponse: (body, init = {}) => ({ __status: init.status || 200, ...body }),
    readJsonBody: async () => (payload === undefined ? { error: null, payload: {} } : { error: null, payload }),
    getMaintenanceNotificationTexts: async () => ({
      start: (stored && stored.start) || 'DEFAULT-START',
      end: (stored && stored.end) || 'DEFAULT-END',
      start_is_default: !(stored && stored.start),
      end_is_default: !(stored && stored.end),
    }),
    _maintLoadStoredTexts: async () => ({
      start: (stored && stored.start) || '',
      end: (stored && stored.end) || '',
    }),
    MAINT_NOTIF_MAX_LEN: 4000,
    appContentRepo: {
      getContent: async () => null,
      updateContent: async (env, type, data, lang) => { calls.updateContent.push({ type, data, lang }); },
    },
    console: { warn: () => {} },
  };
  vm.createContext(sandbox);
  const wrapped = `(async function () {\n${MAINT_ROUTE}\n})()`;
  const result = await vm.runInContext(wrapped, sandbox, { filename: 'worker-proxy.js#maint-route' });
  return { result, calls, sandbox };
}

test('MNT-08: unauthenticated and non-admin users are rejected before ANY data access', async () => {
  // 401 — unauthenticated
  const r1 = await runMaintRoute({
    method: 'GET',
    auth: { error: { __status: 401, detail: 'Authentication required' }, user: null },
    isAdmin: () => false,
  });
  assert.equal(r1.result.__status, 401, 'unauthenticated GET rejected');

  const r2 = await runMaintRoute({
    method: 'PUT',
    auth: { error: { __status: 401, detail: 'Authentication required' }, user: null },
    isAdmin: () => false,
    payload: { start_message: 'x' },
  });
  assert.equal(r2.result.__status, 401, 'unauthenticated PUT rejected');
  assert.equal(r2.calls.updateContent.length, 0, 'no write happened');

  // 403 — authenticated non-admin
  const r3 = await runMaintRoute({
    method: 'GET',
    auth: { error: null, user: { id: '999' } },
    isAdmin: false,
  });
  assert.equal(r3.result.__status, 403, 'non-admin GET rejected');

  const r4 = await runMaintRoute({
    method: 'PUT',
    auth: { error: null, user: { id: '999' } },
    isAdmin: false,
    payload: { start_message: 'hijack' },
  });
  assert.equal(r4.result.__status, 403, 'non-admin PUT rejected');
  assert.equal(r4.calls.updateContent.length, 0, 'no write happened');
});

test('MNT-07b: admin GET returns effective texts; PUT saves ONLY the provided field (merge semantics)', async () => {
  // GET — effective texts + flags.
  const g = await runMaintRoute({
    method: 'GET',
    auth: { error: null, user: { id: '1' } },
    isAdmin: true,
    stored: { start: 'شروع ذخیره‌شده', end: '' },
  });
  assert.equal(g.result.__status, 200);
  assert.equal(g.result.status, 'success');
  assert.equal(g.result.start_message, 'شروع ذخیره‌شده');
  assert.equal(g.result.end_message, 'DEFAULT-END', 'empty stored end ⇒ default in the response');
  assert.equal(g.result.start_is_default, false);
  assert.equal(g.result.end_is_default, true);
  assert.equal(g.result.max_length, 4000);

  // PUT — only start_message provided; the stored END value survives.
  const p = await runMaintRoute({
    method: 'PUT',
    auth: { error: null, user: { id: '1' } },
    isAdmin: true,
    stored: { start: 'قدیمی', end: 'پایان فعلی' },
    payload: { start_message: 'شروع جدید' },
  });
  assert.equal(p.result.__status, 200);
  assert.equal(p.calls.updateContent.length, 1, 'exactly one save');
  const save = p.calls.updateContent[0];
  assert.equal(save.type, 'maintenance_notif', 'stored in the durable app_content row');
  assert.equal(save.lang, 'fa');
  const sections = save.data.sections;
  // NOTE: `sections` was created inside the vm realm — convert to a host
  // array before deepEqual (different Array prototypes fail deepStrictEqual
  // even with identical contents).
  assert.deepEqual(
    [...sections].map((s) => String(s.heading)).sort(),
    ['end_message', 'start_message'],
    'both fields written'
  );
  assert.equal(sections.find((s) => s.heading === 'start_message').body, 'شروع جدید', 'provided field updated');
  assert.equal(sections.find((s) => s.heading === 'end_message').body, 'پایان فعلی', 'unprovided field PRESERVED');
  assert.equal(save.data.updated_by, '1', 'updated_by = the admin telegram id');

  // PUT — empty string clears back to default.
  const p2 = await runMaintRoute({
    method: 'PUT',
    auth: { error: null, user: { id: '1' } },
    isAdmin: true,
    stored: { start: 'شروع قبلی', end: '' },
    payload: { start_message: '   ' },
  });
  const s2 = p2.calls.updateContent[0].data.sections.find((s) => s.heading === 'start_message');
  assert.equal(s2.body, '', 'whitespace-only input clears the custom text (default applies at send time)');
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-09 / MNT-10 — queue path + force_channel semantics (behavioral)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the REAL processBroadcastFull with a fake DB dispatching its
 * queries, and capture the unnest INSERT arrays (notifications vs queue)
 * plus every users-table query SQL (audience assertions).
 */
async function runBroadcastFull(broadcastRow, users, prefs) {
  const calls = { telegramSends: 0, notifInserts: [], queueInserts: [], userQueries: [] };
  const sendTelegramMessageFn = async () => { calls.telegramSends += 1; return { ok: true, messageId: 1 }; };
  const usersLeft = [...users];
  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    isDatabaseConfigured: () => true,
    queryDb: async (env, sql, params) => {
      sql = sql.trim();
      if (sql.startsWith('SELECT * FROM notification_broadcasts WHERE id =')) {
        return { rows: [broadcastRow] };
      }
      if (sql.startsWith('UPDATE notification_broadcasts') && sql.includes("SET status = 'sending'")) {
        return { rows: broadcastRow.status === 'pending' ? [{ id: broadcastRow.id }] : [] };
      }
      if (sql.includes('SELECT telegram_id FROM users')) {
        calls.userQueries.push(sql);
        const batch = usersLeft.splice(0, params[0]);
        return { rows: batch.map((u) => ({ telegram_id: u })) };
      }
      if (sql.includes('FROM notification_settings')) {
        const wanted = params; // user ids
        return { rows: wanted.map((uid) => ({ user_id: uid, pref: prefs[uid] || 'both' })) };
      }
      if (sql.includes('INSERT INTO notifications')) {
        calls.notifInserts.push({ ids: params[0], users: params[1] });
        return {};
      }
      if (sql.includes('INSERT INTO notification_queue')) {
        calls.queueInserts.push({ notifIds: params[0], users: params[1] });
        return {};
      }
      if (sql.startsWith('UPDATE notification_broadcasts')) {
        return { rowCount: 1 };
      }
      return {};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(GET_CHANNEL_COLUMN_SRC, sandbox, { filename: 'np.js#_getChannelColumn' });
  vm.runInContext(PROCESS_BROADCAST_FULL_SRC, sandbox, { filename: 'np.js#processBroadcastFull' });
  const result = await sandbox.processBroadcastFull({ env: true }, sendTelegramMessageFn, broadcastRow.id, null);
  return { calls, result };
}

test('MNT-09: force_channel broadcast (maintenance) enqueues EVERY target user on BOTH channels — queue-only, no direct sends', async () => {
  const users = ['u-none', 'u-mini', 'u-tg', 'u-both', 'u-nosetting'];
  const prefs = { 'u-none': 'none', 'u-mini': 'mini_app', 'u-tg': 'telegram', 'u-both': 'both' };
  const { calls } = await runBroadcastFull(
    {
      id: 7, status: 'pending', last_processed_user_id: null,
      title: '🔧 تست', message: 'متن پیام', category: 'system', priority: 'high',
      metadata: { maintenance_period_id: 'maint_T', maintenance_kind: 'start', force_channel: true, target_all_users: true, dedup_key: 'maint_start_maint_T' },
    },
    users, prefs
  );
  const notifUsers = calls.notifInserts.flatMap((i) => i.users);
  const queueUsers = calls.queueInserts.flatMap((i) => i.users);
  assert.equal(calls.telegramSends, 0, 'processBroadcastFull NEVER calls sendTelegramMessage — queue-only');
  for (const u of users) {
    assert.ok(queueUsers.includes(u), `${u} enqueued for Telegram delivery (preference overridden for the critical system notice)`);
    assert.ok(notifUsers.includes(u), `${u} also receives the in-app notification`);
  }
  // Every users-table query omits the channel_joined filter (all-users audience).
  assert.ok(calls.userQueries.length > 0, 'users query issued');
  for (const sql of calls.userQueries) {
    assert.ok(!sql.includes('channel_joined'), `no channel_joined filter in: ${sql}`);
  }
});

test('MNT-16: audience = ALL users who started the bot — no channel-membership condition, premium/free equal, notif-off user still served', async () => {
  // Real-world mix: a user who NEVER joined the channel, a premium user, a
  // free user, and a user whose normal system notifications are OFF
  // (ch_system='none' — the pref column the broadcast path reads for
  // category 'system'). All must be enqueued on BOTH channels.
  const users = ['u-nochannel', 'u-premium', 'u-free', 'u-notifoff', 'u-channelmember'];
  const prefs = { 'u-nochannel': 'both', 'u-premium': 'mini_app', 'u-free': 'both', 'u-notifoff': 'none', 'u-channelmember': 'telegram' };
  const { calls } = await runBroadcastFull(
    {
      id: 9, status: 'pending', last_processed_user_id: null,
      title: '🟢 بازگشت سرویس', message: 'body', category: 'system', priority: 'high',
      metadata: { maintenance_period_id: 'maint_T', maintenance_kind: 'end', force_channel: true, target_all_users: true, dedup_key: 'maint_end_maint_T' },
    },
    users, prefs
  );
  const notifUsers = calls.notifInserts.flatMap((i) => i.users);
  const queueUsers = calls.queueInserts.flatMap((i) => i.users);
  assert.equal(queueUsers.length, users.length, 'every started user is enqueued for Telegram');
  assert.equal(notifUsers.length, users.length, 'every started user also gets the in-app copy');
  for (const u of users) {
    assert.ok(queueUsers.includes(u), `${u} receives the maintenance Telegram message`);
  }
  // The user with normal notifications OFF still receives BOTH copies — the
  // forced send exception applies to maintenance start/end only.
  assert.ok(queueUsers.includes('u-notifoff') && notifUsers.includes('u-notifoff'),
    "ch_system='none' user still served (mandatory system notice)");
  // No channel-membership condition in the targeting SQL.
  for (const sql of calls.userQueries) {
    assert.ok(!sql.includes('channel_joined'), 'channel membership is NOT a targeting condition');
    assert.match(sql, /SELECT telegram_id FROM users\s+(WHERE telegram_id > \$2\s+)?ORDER BY telegram_id ASC/i,
      'targets the full users table (the real sendable-user list, checkpoint-resumable)');
  }
  assert.equal(calls.telegramSends, 0, 'still queue-only');
});

test('MNT-10: legacy broadcasts (no force_channel) keep the exact previous preference-driven behavior', async () => {
  const users = ['u-none', 'u-mini', 'u-tg', 'u-both'];
  const prefs = { 'u-none': 'none', 'u-mini': 'mini_app', 'u-tg': 'telegram', 'u-both': 'both' };
  const { calls } = await runBroadcastFull(
    {
      id: 8, status: 'pending', last_processed_user_id: null,
      title: 'تحلیل', message: 'body', category: 'analysis', priority: 'medium',
      metadata: {},
    },
    users, prefs
  );
  const notifUsers = calls.notifInserts.flatMap((i) => i.users);
  const queueUsers = calls.queueInserts.flatMap((i) => i.users);
  assert.ok(!queueUsers.includes('u-none') && !notifUsers.includes('u-none'), "'none' user still fully skipped");
  assert.ok(!queueUsers.includes('u-mini') && notifUsers.includes('u-mini'), "'mini_app' user still in-app only");
  assert.ok(queueUsers.includes('u-tg') && !notifUsers.includes('u-tg'), "'telegram' user still telegram only");
  assert.ok(queueUsers.includes('u-both') && notifUsers.includes('u-both'), "'both' user still both");
  assert.equal(calls.telegramSends, 0);
  // Audience unchanged too: legacy broadcasts keep the channel_joined=TRUE filter.
  assert.ok(calls.userQueries.length > 0, 'users query issued');
  for (const sql of calls.userQueries) {
    assert.ok(sql.includes('WHERE channel_joined = TRUE'), `legacy target set preserved in: ${sql}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-11 / MNT-12 / MNT-13 — wiring pins (scheduler, admin PUT hook, UI)
// ═══════════════════════════════════════════════════════════════════════════

test('MNT-11: 5-min cron runs the maintenance tick; scheduled() passes the dependency', () => {
  // scheduler: dependency destructured + invoked inside the 5-min phase.
  assert.match(SCHED_SRC, /maintenanceNotificationTick,/, 'dep destructured');
  assert.match(SCHED_SRC, /await maintenanceNotificationTick\(env, pool\)/, 'tick invoked with the shared phase pool');
  // The tick call must sit inside the isEvery5Min block (Phase 4 area),
  // before phase1b (processBroadcastBatch) which drains what it inserts.
  const tickIdx = SCHED_SRC.indexOf('await maintenanceNotificationTick(env, pool)');
  const phase4Idx = SCHED_SRC.indexOf("if (isEvery5Min && notificationPlatformRepo)");
  const phase1bIdx = SCHED_SRC.indexOf('PHASE 1b: Broadcast batch');
  assert.ok(phase4Idx !== -1 && tickIdx > phase4Idx, 'tick runs in the 5-min phase');
  assert.ok(phase1bIdx !== -1 && tickIdx < phase1bIdx, 'tick runs BEFORE processBroadcastBatch (same-tick drain)');
  // worker-proxy: scheduled() shell passes the dep.
  assert.match(WORKER_SRC, /setCalendarIsolateCache,\s*\n\s*maintenanceNotificationTick,\s*\n\s*\}\);/, 'scheduled() deps include maintenanceNotificationTick');
});

test('MNT-12: admin PUT hook — prev-state snapshot + backgroundTask ONLY on the real transition', () => {
  // Prev-state snapshot BEFORE the write (true transition detection).
  assert.match(WORKER_SRC, /const _maintPrevState = await getMaintenanceState\(env\);/, 'prev state read before write');
  const prevIdx = WORKER_SRC.indexOf('const _maintPrevState = await getMaintenanceState(env);');
  const setIdx = WORKER_SRC.indexOf('const newState = await setMaintenanceState(env, patch, authState.user.id);');
  assert.ok(prevIdx !== -1 && setIdx !== -1 && prevIdx < setIdx, 'snapshot precedes the state write');
  // Start notification scheduled via backgroundTask, gated on the transition.
  assert.match(
    WORKER_SRC,
    /backgroundTask\(env, maintenanceStartNotification\(env, authState\.user\.id, _mntNext\.period_id\)\);/,
    'start notification runs as a non-blocking background task'
  );
  assert.match(WORKER_SRC, /_maintPrevState\.maintenance\.enabled !== true/, 'fires only when the previous state was NOT enabled');
});

test('MNT-13: UI wiring — maintenance settings live in the SYSTEM-CONTROLS (maintenance) section, NOT the notification center or advertisements', () => {
  // ── system-controls section: static card + container (the relocation target). ──
  assert.match(HTML, /<div class="adm-card" id="adm-maint-notif-card">/, 'static maint-notif card');
  assert.match(HTML, /id="maint-notif-section"/, 'render container');
  // The card sits inside the system-controls section (after the Maintenance
  // Mode card / stats / presets — the section that owns maintenance).
  const sysIdx = HTML.indexOf('id="admin-section-system-controls"');
  const cardIdx = HTML.indexOf('id="adm-maint-notif-card"');
  const sysEnd = HTML.indexOf('</section>', sysIdx);
  assert.ok(sysIdx !== -1 && cardIdx > sysIdx && cardIdx < sysEnd, 'card is inside the system-controls section');
  // Static title + description are translated via data-i18n (applyLanguage).
  assert.match(HTML, /data-i18n="adm_maint_notif_section_title"/, 'static card title (i18n)');
  assert.match(HTML, /data-i18n="adm_maint_notif_section_desc"/, 'static card description (i18n)');

  // ── advertisements section: the maintenance tab is GONE. ──
  assert.ok(!/data-ads-tab="maintenance"/.test(HTML), 'no maintenance tab left in the ads tab bar');
  assert.ok(!HTML.includes('ads-tab-maintenance') && !HTML.includes('ads-maintenance-section'), 'no ads maintenance containers left');
  const adsSwitch = extractFn(ADMIN_SRC, 'switchAdsTab', false);
  assert.ok(!/maintenance/.test(adsSwitch), 'switchAdsTab has no maintenance case');

  // ── notification center: the maintenance tab is GONE. ──
  assert.ok(!/data-np-tab="maintenance"/.test(HTML), 'no maintenance tab left in notification center');
  assert.ok(!HTML.includes('np-maintenance-section'), 'no maintenance container left in notification center');
  const notifSwitch = extractFn(ADMIN_SRC, 'switchNotificationTab', false);
  assert.ok(!/maintenance/.test(notifSwitch), 'switchNotificationTab has no maintenance case');

  // ── admin.js: section dispatch, loaders, live preview (XSS-safe), per-field save. ──
  const sectionSwitch = extractFn(ADMIN_SRC, 'switchAdminSection', false);
  assert.match(sectionSwitch, /case 'system-controls': loadMaintenanceSettings\(\); loadMaintenanceNotifTexts\(\); break;/, 'system-controls dispatch loads BOTH the mode settings and the notif texts');
  assert.match(ADMIN_SRC, /window\.loadMaintenanceNotifTexts = loadMaintenanceNotifTexts;/, 'loader exported (onclick contract)');
  assert.match(ADMIN_SRC, /window\.maintNotifPreview = maintNotifPreview;/, 'preview exported');
  assert.match(ADMIN_SRC, /window\.maintNotifSave = maintNotifSave;/, 'save exported');
  assert.match(ADMIN_SRC, /preview\.textContent = input\.value; \/\/ DOM property — no HTML injection/, 'preview renders via textContent');
  assert.match(ADMIN_SRC, /maxlength="' \+ maxLen \+ '" dir="rtl"/, 'textarea bounded by the server-provided max length');
  assert.match(ADMIN_SRC, /'\/api\/admin\/maintenance\/notif-texts',/, 'panel talks to the admin route');
  assert.match(ADMIN_SRC, /getElementById\('maint-notif-section'\)/, 'renders into the system-controls container');
  // Save button is restored in a finally block (never permanently disabled).
  const saveFn = extractFn(ADMIN_SRC, 'maintNotifSave', true);
  assert.match(saveFn, /finally\s*\{[\s\S]*?btn\.disabled = false;[\s\S]*?btn\.textContent = t\('adm_maint_notif_save'\);[\s\S]*?\}/, 'button state always restored');

  // ── CSS: preview bubble + meta row scoped to the system-controls section. ──
  assert.match(CSS_SRC, /#admin-section-system-controls \.maint-notif-preview \{/, 'preview bubble style');
  assert.match(CSS_SRC, /#admin-section-system-controls \.maint-notif-meta \{/, 'meta row style');
  assert.ok(!CSS_SRC.includes('#admin-section-advertisements .ads-maint'), 'old advertisements scope fully removed');
  assert.ok(!CSS_SRC.includes('#admin-section-notification-center .np-maint'), 'old notification-center scope fully removed');

  // ── i18n: every key used by the panel exists in BOTH dictionaries. ──
  const faBlock = I18N_SRC.slice(0, I18N_SRC.indexOf("en: {"));
  const enBlock = I18N_SRC.slice(I18N_SRC.indexOf("en: {"));
  for (const key of [
    'adm_maint_notif_section_title', 'adm_maint_notif_section_desc',
    'adm_maint_notif_start_label', 'adm_maint_notif_end_label', 'adm_maint_notif_preview',
    'adm_maint_notif_char_hint', 'adm_maint_notif_save', 'adm_maint_notif_saving',
    'adm_maint_notif_saved', 'adm_maint_notif_save_error', 'adm_maint_notif_load_error',
    'adm_maint_notif_default_badge', 'adm_maint_notif_custom_badge',
  ]) {
    assert.ok(faBlock.includes(`${key}:`), `${key} missing in fa`);
    assert.ok(enBlock.includes(`${key}:`), `${key} missing in en`);
  }
  // Both scoped tab keys are retired (no dead keys).
  assert.ok(!I18N_SRC.includes('adm_np_tab_maintenance:'), 'np-scoped tab key removed from both dictionaries');
  assert.ok(!I18N_SRC.includes('adm_ads_tab_maintenance:'), 'ads-scoped tab key removed from both dictionaries (Phase 4 move)');
});

test('MNT-15: the maintenance broadcast uses the STANDARD platform — no parallel send path', () => {
  const maintBlock = MAINT_REGION;
  // The start/end helpers reference ONLY notificationPlatformRepo functions
  // (createDedupBroadcast / processBroadcastFull) — never a direct
  // sendTelegramMessage / fetch call of their own.
  const startFn = extractFn(maintBlock, 'maintenanceStartNotification', true);
  const tickFn = extractFn(maintBlock, 'maintenanceNotificationTick', true);
  for (const [name, fn] of [['maintenanceStartNotification', startFn], ['maintenanceNotificationTick', tickFn]]) {
    assert.ok(!/sendTelegramMessage\(/.test(fn), `${name} never calls sendTelegramMessage directly`);
    assert.ok(!/api\.telegram\.org/.test(fn), `${name} never hits the Telegram API directly`);
    assert.match(fn, /notificationPlatformRepo\.createDedupBroadcast\(/, `${name} inserts through the repo`);
  }
  // Broadcasts are created as 'pending' rows drained by the standard cron.
  assert.match(CREATE_DEDUP_BROADCAST_SRC, /'pending'/, 'broadcast rows start pending (standard drain path)');
});

test('MNT-19: forced delivery (force_channel + target_all_users) is opt-in ONLY for maintenance broadcasts — nothing else sets the flags', () => {
  // (a) In worker-proxy.js, the ONLY places that construct broadcast metadata
  //     with force_channel/target_all_users are inside the [MAINT-NOTIF] block.
  const before = WORKER_SRC.slice(0, WORKER_SRC.indexOf('// [MAINT-NOTIF-START]'));
  const maintStart = WORKER_SRC.indexOf('// [MAINT-NOTIF-START]');
  const maintEnd = WORKER_SRC.indexOf('// [MAINT-NOTIF-END]');
  const maintBody = WORKER_SRC.slice(maintStart, maintEnd);
  const after = WORKER_SRC.slice(maintEnd + '// [MAINT-NOTIF-END]'.length);
  assert.ok(maintStart !== -1 && maintEnd !== -1, 'maint region markers present');
  for (const part of [before, after]) {
    assert.ok(!part.includes('force_channel: true'), 'no force_channel outside the maintenance feature');
    assert.ok(!part.includes('target_all_users: true'), 'no target_all_users outside the maintenance feature');
  }
  const flagCount = (maintBody.match(/force_channel: true/g) || []).length;
  const targetAllCount = (maintBody.match(/target_all_users: true/g) || []).length;
  assert.equal(flagCount, 3, 'exactly the 3 maintenance broadcast creation sites set force_channel');
  assert.equal(targetAllCount, 3, 'exactly the 3 maintenance broadcast creation sites set target_all_users');

  // (b) In the notification platform, both flags are read STRICTLY from the
  //     broadcast row's metadata (opt-in) — no other source can enable them.
  const pbf = PROCESS_BROADCAST_FULL_SRC;
  assert.match(pbf, /_bMeta\.force_channel === true/, 'force_channel comes from broadcast metadata only');
  assert.match(pbf, /_bMeta\.target_all_users === true/, 'target_all_users comes from broadcast metadata only');
  // No other code path constructs these flags (the admin broadcast creator
  // included — the flags are not exposed to any request payload).
  const npOutside = NP_SRC.replace(PROCESS_BROADCAST_FULL_SRC, '');
  assert.ok(!npOutside.includes('force_channel: true') && !npOutside.includes('target_all_users: true'),
    'the notification platform itself never sets the flags — only reads them');

  // (c) sendNotification's legacy forceChannel parameter is UNTOUCHED (the
  //     documented "admin/system critical only" escape hatch predates this
  //     feature and its callers are unchanged).
  assert.match(NP_SRC, /if \(!forceChannel\)/, 'legacy sendNotification forceChannel semantics intact');
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-17 — bot-blocked / invalid-id users: bounded queue retries (behavioral)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the REAL processQueue against an in-memory notification_queue that
 * implements the production row semantics:
 *   - claim:  only status='pending' AND attempts < max_attempts rows are
 *             claimed (FOR UPDATE SKIP LOCKED simulated by serial ticks);
 *   - failure: attempts + 1; status = 'failed' once attempts reaches
 *             max_attempts, else back to 'pending' with next_retry_at.
 * sendFailures maps user_id → Error the fake sendTelegramMessage throws.
 */
async function runQueueTicks(items, sendFailures, ticks) {
  const calls = { sends: [] };
  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    isDatabaseConfigured: () => true,
    queryDb: async (env, sql) => {
      sql = sql.trim();
      if (sql.startsWith('UPDATE notification_queue') && sql.includes("SET status = 'processing'")) {
        const claimable = items.filter((i) => i.status === 'pending' && i.attempts < i.max_attempts);
        for (const i of claimable) i.status = 'processing';
        return { rows: claimable.map((i) => ({ ...i })) };
      }
      if (sql.startsWith('UPDATE notification_queue') && sql.includes('attempts = attempts + 1')) {
        // The REAL code sets: status = CASE WHEN attempts+1 >= max_attempts
        // THEN 'failed' ELSE 'pending' END, attempts = attempts + 1.
        const processing = items.filter((i) => i.status === 'processing');
        for (const i of processing) {
          i.attempts += 1;
          i.status = i.attempts >= i.max_attempts ? 'failed' : 'pending';
        }
        return {};
      }
      if (sql.startsWith('UPDATE notification_queue') && sql.includes("SET status = 'processed'")) {
        for (const i of items) if (i.status === 'processing') { i.status = 'processed'; }
        return {};
      }
      return {};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PROCESS_QUEUE_SRC, sandbox, { filename: 'np.js#processQueue' });
  const sendTelegramMessageFn = async (env, payload) => {
    calls.sends.push(payload.chat_id);
    const err = sendFailures[payload.chat_id];
    if (err) throw err;
    return { ok: true, messageId: 1 };
  };
  const results = [];
  for (let t = 0; t < ticks; t++) {
    results.push(await sandbox.processQueue({ env: true }, sendTelegramMessageFn, null, 10));
  }
  return { calls, items, results };
}

test('MNT-17: bot-blocked user (Telegram 403) — bounded retries, terminal failed, NEVER an infinite loop', async () => {
  const blocked = 'u-blocked';
  const err403 = new Error('Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user');
  const item = {
    id: 'q-1', user_id: blocked, channel: 'telegram', status: 'pending',
    attempts: 0, max_attempts: 3, telegram_message_id: null,
    payload: { title: '🔧 تعمیرات', message: 'متن شروع' },
  };
  // 5 cron ticks — more than max_attempts: after 3 failed sends the row must
  // be terminal 'failed' and never claimed/sent again.
  const { calls, items } = await runQueueTicks([item], { [blocked]: err403 }, 5);
  assert.equal(calls.sends.length, 3, 'exactly max_attempts send attempts — then the row is dropped from retry');
  assert.equal(calls.sends.filter((c) => c === blocked).length, 3, 'all attempts hit the blocked user');
  assert.equal(items[0].status, 'failed', 'terminal status is failed (never pending again)');
  assert.equal(items[0].attempts, 3, 'attempts capped at max_attempts');

  // Same path for an invalid chat id (400 Bad Request — identical handling).
  const invalid = 'u-invalid-id';
  const err400 = new Error('Telegram sendMessage failed: 400 Bad Request: chat not found');
  const item2 = {
    id: 'q-2', user_id: invalid, channel: 'telegram', status: 'pending',
    attempts: 0, max_attempts: 3, telegram_message_id: null,
    payload: { title: '🟢 پایان', message: 'متن پایان' },
  };
  const r2 = await runQueueTicks([item2], { [invalid]: err400 }, 5);
  assert.equal(r2.calls.sends.length, 3, 'invalid id: exactly max_attempts attempts');
  assert.equal(r2.items[0].status, 'failed', 'invalid id: terminal failed');

  // Contrast: a TRANSIENT failure (429-style network error) is also capped at
  // max_attempts — the queue never retries forever for ANY user.
  const transient = 'u-flaky';
  const errNet = new Error('network down');
  const item3 = {
    id: 'q-3', user_id: transient, channel: 'telegram', status: 'pending',
    attempts: 0, max_attempts: 3, telegram_message_id: null,
    payload: { title: '🔧', message: 'x' },
  };
  const r3 = await runQueueTicks([item3], { [transient]: errNet }, 5);
  assert.equal(r3.calls.sends.length, 3, 'transient error: still bounded');
  assert.equal(r3.items[0].status, 'failed', 'transient error: terminal failed after cap');

  // Sanity: a healthy user is delivered exactly once (no retry storm).
  const ok = 'u-healthy';
  const item4 = {
    id: 'q-4', user_id: ok, channel: 'telegram', status: 'pending',
    attempts: 0, max_attempts: 3, telegram_message_id: null,
    payload: { title: '🔧', message: 'x' },
  };
  const r4 = await runQueueTicks([item4], {}, 3);
  assert.equal(r4.calls.sends.filter((c) => c === ok).length, 1, 'healthy user delivered once');
  assert.equal(r4.items[0].status, 'processed', 'healthy user terminal processed');
});

// ═══════════════════════════════════════════════════════════════════════════
// MNT-18 — relocated editor behaves end-to-end in system-controls (behavioral)
// ═══════════════════════════════════════════════════════════════════════════

test('MNT-18: relocated editor — renders in the system-controls section, live preview, per-field save WITHOUT clobbering the other field', async () => {
  // Minimal DOM: the maint-notif-section container + elements the code
  // looks up by id (textareas, previews, counts, badges, save buttons).
  const elements = {};
  const el = (id, extra) => {
    elements[id] = Object.assign({
      id, value: '', innerHTML: '', textContent: '', maxLength: 4000,
      className: '', disabled: false,
    }, extra || {});
    return elements[id];
  };
  el('maint-notif-start-input', { value: '' });
  el('maint-notif-end-input', { value: '' });
  el('maint-notif-start-preview');
  el('maint-notif-end-preview');
  el('maint-notif-start-count');
  el('maint-notif-end-count');
  el('maint-notif-start-badge', { className: 'admin-badge admin-badge-gray' });
  el('maint-notif-end-badge', { className: 'admin-badge admin-badge-green' });
  el('maint-notif-start-save', { textContent: '' });
  el('maint-notif-end-save', { textContent: '' });
  const sectionEl = { innerHTML: '' };
  const calls = { fetches: [], toasts: [] };
  let GET_RESPONSE = {
    status: 'success',
    start_message: 'متن شروع ذخیره‌شده', end_message: 'متن پایان ذخیره‌شده',
    start_is_default: false, end_is_default: false, max_length: 4000,
  };
  let PUT_RESPONSE = null;
  const sandbox = {
    document: { getElementById: (id) => (id === 'maint-notif-section' ? sectionEl : (elements[id] || null)) },
    t: (k) => k,
    _adminLoadToken: 0,
    _isLoadTokenStale: () => false,
    adminEscapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    showAdminToast: (msg, kind) => { calls.toasts.push({ msg, kind }); },
    adminApiFetch: (path, options) => {
      calls.fetches.push({ path, options });
      if (options && options.method === 'PUT') {
        return Promise.resolve(PUT_RESPONSE || {
          status: 'success',
          start_message: JSON.parse(options.body).start_message != null ? JSON.parse(options.body).start_message : GET_RESPONSE.start_message,
          end_message: GET_RESPONSE.end_message,
          start_is_default: !JSON.parse(options.body).start_message,
          end_is_default: GET_RESPONSE.end_is_default,
          max_length: 4000,
        });
      }
      return Promise.resolve(GET_RESPONSE);
    },
    console: { error: () => {}, log: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(ADMIN_SRC, 'loadMaintenanceNotifTexts', true), sandbox, { filename: 'admin.js#loadMaintenanceNotifTexts' });
  vm.runInContext(extractFn(ADMIN_SRC, 'maintNotifPreview', false), sandbox, { filename: 'admin.js#maintNotifPreview' });
  vm.runInContext(extractFn(ADMIN_SRC, 'maintNotifSave', true), sandbox, { filename: 'admin.js#maintNotifSave' });

  // 1. Load — renders the two stored texts into the system-controls fields.
  //    (The card chrome — title + description — is STATIC index.html markup
  //    translated via data-i18n; the loader renders the field cards.)
  await sandbox.loadMaintenanceNotifTexts();
  assert.ok(sectionEl.innerHTML.includes('adm_maint_notif_start_label') && sectionEl.innerHTML.includes('adm_maint_notif_end_label'), 'both field labels rendered');
  assert.ok(sectionEl.innerHTML.includes('id="maint-notif-start-input"') && sectionEl.innerHTML.includes('id="maint-notif-end-input"'), 'both textareas rendered in the system-controls section');
  assert.ok(sectionEl.innerHTML.includes('oninput="maintNotifPreview(\'start\')"'), 'live preview wired (start)');
  assert.ok(sectionEl.innerHTML.includes('onclick="maintNotifSave(\'end\')"'), 'per-field save wired (end)');
  // The harness DOM is pre-populated by the render path (real browser parses
  // the innerHTML); simulate the browser by seeding the values from the API.
  elements['maint-notif-start-input'].value = GET_RESPONSE.start_message;
  elements['maint-notif-end-input'].value = GET_RESPONSE.end_message;
  sandbox.maintNotifPreview('start');
  assert.equal(elements['maint-notif-start-preview'].textContent, 'متن شروع ذخیره‌شده', 'live preview mirrors the start text');
  assert.equal(elements['maint-notif-start-count'].textContent, '18 / 4000', 'char counter live-updates');

  // 2. XSS safety: preview uses textContent — raw HTML in the text never
  //    becomes markup (only the browser-parsed textarea escaping matters).
  elements['maint-notif-end-input'].value = '<img src=x onerror=alert(1)>';
  sandbox.maintNotifPreview('end');
  assert.equal(elements['maint-notif-end-preview'].textContent, '<img src=x onerror=alert(1)>', 'preview renders HTML text literally — no injection');

  // 3. Save the START field while the END field holds unsaved edits.
  elements['maint-notif-start-input'].value = 'متن شروع جدید ویرایش‌شده';
  PUT_RESPONSE = {
    status: 'success',
    start_message: 'متن شروع جدید ویرایش‌شده',
    end_message: 'متن پایان ذخیره‌شده', // server keeps the OLD end text (merge)
    start_is_default: false, end_is_default: false, max_length: 4000,
  };
  await sandbox.maintNotifSave('start');
  const put = calls.fetches.find((f) => f.options && f.options.method === 'PUT');
  assert.ok(put, 'a PUT was issued');
  assert.deepEqual(JSON.parse(put.options.body), { start_message: 'متن شروع جدید ویرایش‌شده' }, 'PUT body contains ONLY the saved field (merge semantics)');
  assert.equal(elements['maint-notif-start-input'].value, 'متن شروع جدید ویرایش‌شده', 'start field reflects the stored value');
  // The unsaved END edit survives — saving one field never re-renders/clobbers the other.
  assert.equal(elements['maint-notif-end-input'].value, '<img src=x onerror=alert(1)>', 'END field keeps its unsaved edit');
  assert.equal(elements['maint-notif-end-badge'].className, 'admin-badge admin-badge-green', 'END badge untouched by the START save');
  assert.equal(elements['maint-notif-start-save'].disabled, false, 'save button restored');
  assert.equal(calls.toasts.length, 1, 'success toast shown');

  // 4. Error path: failed save → error toast, button restored, retry possible.
  calls.fetches.length = 0;
  const failSandbox = { ...sandbox, adminApiFetch: () => Promise.reject(new Error('network down')) };
  // (rebuild sandbox for the failure case — same functions, failing fetch)
  const failElements = {};
  for (const [id, v] of Object.entries(elements)) failElements[id] = { ...v };
  const failCtx = {
    document: { getElementById: (id) => (id === 'maint-notif-section' ? { innerHTML: '' } : (failElements[id] || null)) },
    t: (k) => k,
    adminApiFetch: () => Promise.reject(new Error('network down')),
    showAdminToast: (msg, kind) => { calls.toasts.push({ msg, kind }); },
    adminEscapeHtml: sandbox.adminEscapeHtml,
    console: { error: () => {}, log: () => {} },
  };
  vm.createContext(failCtx);
  vm.runInContext(extractFn(ADMIN_SRC, 'maintNotifSave', true), failCtx, { filename: 'admin.js#maintNotifSave' });
  await failCtx.maintNotifSave('start');
  assert.equal(failElements['maint-notif-start-save'].disabled, false, 'button restored after error');
  assert.equal(failElements['maint-notif-start-save'].textContent, 'adm_maint_notif_save', 'label restored after error');
  assert.ok(calls.toasts.some((x) => x.kind === 'error'), 'error toast surfaced');
});

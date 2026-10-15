/**
 * RISK-1 HARDENING — RESERVED BROADCAST METADATA FLAGS (regression tests)
 * =====================================================================
 * Phase 2 hardening on feature/maintenance-auto-notifications.
 *
 * `force_channel` and `target_all_users` are RESERVED metadata flags: they
 * switch a broadcast into "forced delivery on both channels" and "target the
 * FULL users table" mode. The ONLY trusted setter is the maintenance path
 * (worker-proxy maintenanceStartNotification / maintenanceNotificationTick →
 * repo.createDedupBroadcast, server-built metadata). The PUBLIC boundary is
 * repo.createBroadcast — reached verbatim from the admin request body via
 * the notification platform controller's handleCreateBroadcast.
 *
 * The fix strips the two reserved flags inside createBroadcast, right before
 * the metadata column is persisted. These tests lock the REAL behavior of
 * every side of that boundary:
 *
 *   RF-01  Hand-crafted normal broadcast with the reserved flags in
 *          (object) metadata → flags stripped, ALL other metadata keys
 *          preserved, every other INSERT column byte-identical.
 *   RF-02  The string-encoded variant (metadata as a JSON string) cannot
 *          smuggle the flags past the strip (processBroadcastFull JSON.parses
 *          string metadata at read time — the strip covers that decode path).
 *   RF-03  Behavior preservation for clean input: byte-identical storage,
 *          undefined/null → {}, arrays and unparseable strings unchanged,
 *          caller's object NEVER mutated.
 *   RF-04  END-TO-END (controller → repo → processor): a hand-crafted admin
 *          request carrying both flags produces a broadcast that behaves
 *          EXACTLY like a legacy normal broadcast — channel_joined=TRUE
 *          audience + per-user preference delivery (no forced 'both', no
 *          all-users targeting).
 *   RF-05  Unauthorized requests are rejected verbatim BEFORE any repo call
 *          (no INSERT, no processing), still with the 'broadcast' permission
 *          scope.
 *   RF-06  Maintenance trusted path differential: the REAL createDedupBroadcast
 *          still persists BOTH reserved flags, and the REAL processBroadcastFull
 *          still honors them (forced both-channels + full-users audience).
 *   RF-07  Source-level fast-fail pins (supplementary): the strip lives in
 *          createBroadcast only — never in createDedupBroadcast; the 3
 *          maintenance creation sites in worker-proxy.js still set both flags.
 *
 * Behavioral harness: the REAL repo functions and the REAL controller factory
 * are extracted from source and executed in vm sandboxes with a fake DB
 * dispatching every SQL statement of the chain. All tests are offline.
 *
 * Run: node --test tests/broadcast-reserved-flags-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const NP_SRC = read('src/repositories/notification_platform.js');
const CTRL_SRC = read('src/controllers/notification_platform.js');
const WORKER_SRC = read('worker-proxy.js');

// ── Extraction helpers (same brace-counting scheme as the maintenance suite) ─

function extractFn(src, name, isAsync) {
  const needle = `${isAsync ? 'async ' : ''}function ${name}(`;
  const start = src.indexOf(needle);
  if (start === -1) throw new Error(`Function ${name} not found`);
  // Skip the parameter list first (params may contain destructured braces
  // which must NOT be mistaken for the function body).
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

const CREATE_BROADCAST_SRC = extractFn(NP_SRC, 'createBroadcast', true);
const CREATE_DEDUP_BROADCAST_SRC = extractFn(NP_SRC, 'createDedupBroadcast', true);
const PROCESS_BROADCAST_FULL_SRC = extractFn(NP_SRC, 'processBroadcastFull', true);
const GET_CHANNEL_COLUMN_SRC = extractFn(NP_SRC, '_getChannelColumn', false);
const MAP_BROADCAST_SRC = extractFn(NP_SRC, '_mapBroadcast', false);

// The controller is an ES module factory: `export function createNotificationPlatformHandlers(deps)`
// — strip the export so the declaration becomes a global inside the sandbox.
const CTRL_BODY = CTRL_SRC.replace('export function createNotificationPlatformHandlers', 'function createNotificationPlatformHandlers');

// ── Repo-level harness: the REAL createBroadcast with a capturing fake DB ────

const MAPPED_ROW = {
  id: 42, admin_id: '555', title: 'T', message: 'M',
  category: 'announcement', priority: 'medium', channel: 'mini_app',
  target_type: 'all', target_value: {}, scheduled_at: null, sent_at: null,
  status: 'pending', total_sent: 0, total_delivered: 0, total_read: 0,
};

async function runCreateBroadcast(data, opts = {}) {
  const calls = { inserts: [] };
  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    isDatabaseConfigured: () => opts.dbConfigured !== false,
    isoDate: (v) => (v === undefined || v === null ? null : String(v)),
    normalizeOptionalString: (v) => (typeof v === 'string' ? v.trim() : undefined),
    queryDb: async (env, sql, params) => {
      calls.inserts.push({ sql: sql.trim(), params });
      return { rows: [MAPPED_ROW] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(MAP_BROADCAST_SRC, sandbox, { filename: 'np.js#_mapBroadcast' });
  vm.runInContext(CREATE_BROADCAST_SRC, sandbox, { filename: 'np.js#createBroadcast' });
  const row = await sandbox.createBroadcast({ env: true }, data);
  return { calls, row };
}

// ── Controller→repo→processor harness (the full untrusted chain) ────────────

/**
 * Runs the REAL controller factory + REAL createBroadcast + REAL
 * processBroadcastFull in one sandbox. The fake DB persists the INSERTed
 * broadcast row and serves it back for processing; the row's `metadata` is
 * returned EXACTLY as stored (a JSON string) — the adversarial read-back path
 * processBroadcastFull must survive.
 *
 * opts:
 *   rawBody      — string: the raw JSON wire body of the request
 *   users        — array of telegram_ids the fake users table returns
 *   prefs        — map user → notification preference column value
 *   requireAdmin — stub (default: authorized admin 555)
 */
function makeControllerChain(opts) {
  const calls = {
    inserts: [], userQueries: [], notifInserts: [], queueInserts: [],
    telegramSends: 0, requireAdminCalls: [],
  };
  const broadcastRows = [];
  const usersLeft = [...(opts.users || [])];
  const prefs = opts.prefs || {};

  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    isDatabaseConfigured: () => true,
    isoDate: (v) => (v === undefined || v === null ? null : String(v)),
    normalizeOptionalString: (v) => (typeof v === 'string' ? v.trim() : undefined),
    queryDb: async (env, sql, params) => {
      sql = sql.trim();
      if (sql.startsWith('INSERT INTO notification_broadcasts')) {
        calls.inserts.push({ sql, params });
        const row = {
          id: broadcastRows.length + 77,
          admin_id: params[0], title: params[1], message: params[2],
          category: params[3], priority: params[4], channel: params[5],
          target_type: params[6], target_value: JSON.parse(params[7] || '{}'),
          scheduled_at: params[8], status: params[9],
          // metadata served back EXACTLY as persisted (JSON string) —
          // processBroadcastFull must JSON.parse it safely on its own.
          metadata: params[10],
        };
        broadcastRows.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT * FROM notification_broadcasts WHERE id =')) {
        const row = broadcastRows.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE notification_broadcasts') && sql.includes("SET status = 'sending'")) {
        const row = broadcastRows.find((r) => r.id === params[0]);
        return { rows: row && row.status === 'pending' ? [{ id: row.id }] : [] };
      }
      if (sql.includes('SELECT telegram_id FROM users')) {
        calls.userQueries.push(sql);
        const batch = usersLeft.splice(0, params[0]);
        return { rows: batch.map((u) => ({ telegram_id: u })) };
      }
      if (sql.includes('FROM notification_settings')) {
        return { rows: params.map((uid) => ({ user_id: uid, pref: prefs[uid] || 'both' })) };
      }
      if (sql.includes('INSERT INTO notifications')) {
        calls.notifInserts.push({ users: params[1] });
        return {};
      }
      if (sql.includes('INSERT INTO notification_queue')) {
        calls.queueInserts.push({ users: params[1] });
        return {};
      }
      if (sql.startsWith('UPDATE notification_broadcasts')) {
        return { rowCount: 1 };
      }
      return {};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(MAP_BROADCAST_SRC, sandbox, { filename: 'np.js#_mapBroadcast' });
  vm.runInContext(CREATE_BROADCAST_SRC, sandbox, { filename: 'np.js#createBroadcast' });
  vm.runInContext(GET_CHANNEL_COLUMN_SRC, sandbox, { filename: 'np.js#_getChannelColumn' });
  vm.runInContext(PROCESS_BROADCAST_FULL_SRC, sandbox, { filename: 'np.js#processBroadcastFull' });
  vm.runInContext(CTRL_BODY, sandbox, { filename: 'ctrl.js#createNotificationPlatformHandlers' });

  const deps = {
    jsonResponse: (body, init) => ({ __http: (init && init.status) || 200, ...body }),
    authenticateTelegramRequest: async () => ({ user: { id: '1' } }),
    requireAdmin: opts.requireAdmin || (async (request, env, perm) => {
      calls.requireAdminCalls.push({ perm });
      return { error: null, admin: { telegram_id: '555' } };
    }),
    readJsonBody: async () => ({ error: null, payload: JSON.parse(opts.rawBody) }),
    safeDbErrorResponse: () => ({ __http: 503, status: 'error' }),
    safeError: (t, e) => e,
    isDatabaseConfigured: () => true,
    buildBodyFieldValidationError: (field, code) => ({ __http: 422, status: 'error', code }),
    notificationPlatformRepo: {
      createBroadcast: sandbox.createBroadcast,
      processBroadcastFull: sandbox.processBroadcastFull,
    },
    sendTelegramMessage: async () => { calls.telegramSends += 1; return { ok: true }; },
    adminRepo: {},
    membershipAuthority: {},
  };
  const handlers = sandbox.createNotificationPlatformHandlers(deps);
  return { handlers, calls, broadcastRows, sandbox };
}

// ── Processor-only harness (used by the maintenance differential test) ─────

async function runProcessor(broadcastRow, users, prefs) {
  const calls = { telegramSends: 0, notifInserts: [], queueInserts: [], userQueries: [] };
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
        return { rows: params.map((uid) => ({ user_id: uid, pref: prefs[uid] || 'both' })) };
      }
      if (sql.includes('INSERT INTO notifications')) {
        calls.notifInserts.push({ users: params[1] });
        return {};
      }
      if (sql.includes('INSERT INTO notification_queue')) {
        calls.queueInserts.push({ users: params[1] });
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
  await sandbox.processBroadcastFull({ env: true }, async () => { calls.telegramSends += 1; return { ok: true }; }, broadcastRow.id, null);
  return { calls };
}

// ═══════════════════════════════════════════════════════════════════════════
// RF-01 — hand-crafted object metadata: flags stripped, everything else intact
// ═══════════════════════════════════════════════════════════════════════════

test('RF-01: normal broadcast created with reserved flags in metadata cannot persist them — all other metadata/columns preserved', async () => {
  const { calls, row } = await runCreateBroadcast({
    admin_id: '555',
    title: 'اطلاعیه عادی',
    message: 'متن پیام',
    metadata: {
      force_channel: true,
      target_all_users: true,
      source: 'admin-panel',
      campaign: 'q1',
      attempts: 3,
    },
  });

  assert.equal(calls.inserts.length, 1, 'exactly one INSERT statement');
  assert.ok(row && row.id === 42, 'broadcast row returned');

  const stored = JSON.parse(calls.inserts[0].params[10]);
  assert.equal(stored.force_channel, undefined, 'force_channel NOT persisted');
  assert.equal(stored.target_all_users, undefined, 'target_all_users NOT persisted');
  assert.deepEqual(stored, { source: 'admin-panel', campaign: 'q1', attempts: 3 },
    'every non-reserved metadata key survives verbatim');

  // The sanitizer must not touch any other column of the INSERT.
  // (Spread first — params is a cross-realm array built inside the vm.)
  assert.deepEqual(
    [...calls.inserts[0].params.slice(0, 10)],
    ['555', 'اطلاعیه عادی', 'متن پیام', 'announcement', 'medium', 'mini_app', 'all', '{}', null, 'pending'],
    'all non-metadata columns byte-identical to the pre-fix INSERT'
  );

  // Scheduled broadcasts keep their status derivation (same code path).
  const sched = await runCreateBroadcast({
    admin_id: '555', title: 'T', message: 'M',
    scheduled_at: '2026-10-20T10:00:00Z',
    metadata: { force_channel: true },
  });
  assert.equal(sched.calls.inserts[0].params[9], 'scheduled', 'scheduled_at → status scheduled (unchanged)');
  assert.deepEqual(JSON.parse(sched.calls.inserts[0].params[10]), {}, 'flag alone leaves no residue');
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-02 — string-encoded flags (JSON-in-string) cannot smuggle past the strip
// ═══════════════════════════════════════════════════════════════════════════

test('RF-02: string-encoded metadata carrying the reserved flags is sanitized through the parse-back path', async () => {
  // Attacker sends metadata as a STRING. The old code stored it verbatim
  // (JSON.stringify of a string → a JSON string scalar), and
  // processBroadcastFull JSON.parses string metadata at read time — the
  // wrapped flags would have been honored. The strip must cover the decode.
  const wire = '{"force_channel":true,"target_all_users":true,"campaign":"q1","keep":2}';
  const { calls } = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: wire });

  const param = calls.inserts[0].params[10];
  // The stored shape is still a JSON string (behavior preserved)…
  assert.equal(typeof JSON.parse(param), 'string', 'string metadata keeps the string-scalar storage shape');
  // …but the DECODED object (what processBroadcastFull effectively reads)
  // no longer carries the reserved flags.
  const decoded = JSON.parse(JSON.parse(param));
  assert.deepEqual(decoded, { campaign: 'q1', keep: 2 },
    'decoded metadata has no reserved flags, other keys intact');

  // Strings that decode to non-objects (arrays / numbers / null) can never
  // carry the flags — they must stay byte-identical (no behavior change).
  for (const inert of ['[1,2]', '123', 'null', 'not-json-at-all']) {
    const r = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: inert });
    assert.equal(r.calls.inserts[0].params[10], JSON.stringify(inert),
      `inert string ${inert} stored byte-identically`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-03 — clean input: behavior preservation + no caller mutation
// ═══════════════════════════════════════════════════════════════════════════

test('RF-03: normal broadcasts without the reserved flags store metadata byte-identically; caller objects are never mutated', async () => {
  // (a) clean object → byte-identical JSON in the INSERT param
  const clean = { source: 'admin-panel', priority_label: 'P2', nested: { a: 1, list: ['x'] } };
  const a = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: clean });
  assert.equal(a.calls.inserts[0].params[10], JSON.stringify(clean), 'byte-identical metadata storage');
  assert.ok(!('force_channel' in clean) && !('target_all_users' in clean), 'caller object untouched');

  // (b) undefined / null / falsy metadata → {} (exactly the previous default)
  for (const [label, meta] of [['undefined', undefined], ['null', null], ['empty string', ''], ['false', false]]) {
    const r = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: meta });
    assert.equal(r.calls.inserts[0].params[10], '{}', `${label} metadata → {} (unchanged default)`);
  }

  // (c) arrays pass through untouched (cannot carry top-level flags)
  const arr = [1, 'two', { three: 3 }];
  const c = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: arr });
  assert.equal(c.calls.inserts[0].params[10], JSON.stringify(arr), 'array metadata stored as-is');

  // (d) an object WITH the flags is not mutated by the sanitizer (shallow copy)
  const malicious = { force_channel: true, target_all_users: true, keep: 'me' };
  const d = await runCreateBroadcast({ admin_id: '555', title: 'T', message: 'M', metadata: malicious });
  assert.equal(malicious.force_channel, true, 'caller object keeps its own value (not mutated)');
  assert.equal(malicious.target_all_users, true, 'caller object keeps its own value (not mutated)');
  assert.deepEqual(JSON.parse(d.calls.inserts[0].params[10]), { keep: 'me' },
    'persisted copy is the sanitized one');
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-04 — end-to-end: hand-crafted admin request → legacy-normal behavior
// ═══════════════════════════════════════════════════════════════════════════

test('RF-04: END-TO-END — a hand-crafted admin broadcast request with both reserved flags produces a plain normal broadcast', async () => {
  // Raw wire format exactly as a crafted request would carry it.
  const rawBody = JSON.stringify({
    title: '📢 اطلاعیه',
    message: 'متن اطلاعیه برای همه',
    category: 'announcement',
    priority: 'medium',
    channel: 'mini_app',
    target_type: 'all',
    metadata: {
      force_channel: true,      // ← must NOT survive
      target_all_users: true,  // ← must NOT survive
      source: 'crafted-request',
    },
  });
  const users = ['u-none', 'u-mini', 'u-tg', 'u-both'];
  const prefs = { 'u-none': 'none', 'u-mini': 'mini_app', 'u-tg': 'telegram', 'u-both': 'both' };

  const { handlers, calls, broadcastRows } = makeControllerChain({ rawBody, users, prefs });
  const res = await handlers.handleCreateBroadcast(
    { url: 'https://api.test/api/notifications/admin/broadcasts', method: 'POST' },
    {}
  );

  assert.equal(res.__http, 200, 'authorized admin request still succeeds');
  // The controller spreads the processor result over the body, so the final
  // `status` key is the processor's 'completed' — pre-existing shape, pinned.
  assert.equal(res.broadcast && res.broadcast.id, 77, 'created broadcast returned to the admin');
  assert.equal(typeof res.sent, 'number', 'send counters present in the response');
  assert.equal(calls.requireAdminCalls.length, 1, 'auth consulted once');
  assert.equal(calls.requireAdminCalls[0].perm, 'broadcast', "still the 'broadcast' permission scope");
  assert.equal(calls.inserts[0].params[0], '555', 'admin_id stamped from the authed admin');

  // 1) What got persisted: flags gone, allowed keys kept.
  assert.equal(calls.inserts.length, 1, 'exactly one broadcast row inserted');
  const stored = JSON.parse(calls.inserts[0].params[10]);
  assert.deepEqual(stored, { source: 'crafted-request' }, 'persisted metadata has no reserved flags');

  // 2) The row is served back for processing with metadata AS THE STORED
  //    STRING — the adversarial decode path.
  assert.equal(broadcastRows.length, 1);
  assert.equal(broadcastRows[0].metadata, calls.inserts[0].params[10], 'processing reads the persisted metadata');

  // 3) Audience: the LEGACY channel_joined=TRUE target set — the all-users
  //    audience did NOT activate.
  assert.ok(calls.userQueries.length > 0, 'users query issued');
  for (const sql of calls.userQueries) {
    assert.ok(sql.includes('WHERE channel_joined = TRUE'),
      `legacy audience filter preserved in: ${sql}`);
  }

  // 4) Delivery: per-user preference, NOT forced 'both'.
  const notifUsers = calls.notifInserts.flatMap((i) => i.users);
  const queueUsers = calls.queueInserts.flatMap((i) => i.users);
  assert.ok(!notifUsers.includes('u-none') && !queueUsers.includes('u-none'), "'none' user skipped");
  assert.ok(notifUsers.includes('u-mini') && !queueUsers.includes('u-mini'), "'mini_app' user in-app only");
  assert.ok(!notifUsers.includes('u-tg') && queueUsers.includes('u-tg'), "'telegram' user telegram only");
  assert.ok(notifUsers.includes('u-both') && queueUsers.includes('u-both'), "'both' user both channels");
  assert.equal(calls.telegramSends, 0, 'processor stays queue-only (no direct Telegram sends)');
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-05 — unauthorized requests: rejected before any repo call
// ═══════════════════════════════════════════════════════════════════════════

test('RF-05: unauthorized request is rejected verbatim BEFORE any broadcast row is created or processed', async () => {
  const UNAUTHORIZED = { __http: 401, status: 'error', message: 'Admin authentication required' };
  const rawBody = JSON.stringify({
    title: 'T', message: 'M',
    metadata: { force_channel: true, target_all_users: true },
  });
  const { handlers, calls, broadcastRows } = makeControllerChain({
    rawBody,
    users: ['u-1'],
    requireAdmin: async (request, env, perm) => {
      calls.requireAdminCalls.push({ perm });
      return { error: UNAUTHORIZED, admin: null };
    },
  });

  const res = await handlers.handleCreateBroadcast(
    { url: 'https://api.test/api/notifications/admin/broadcasts', method: 'POST' },
    {}
  );

  assert.equal(res, UNAUTHORIZED, 'the auth error is propagated verbatim');
  assert.equal(res.__http, 401, '401 surfaces to the client');
  assert.deepEqual(calls.requireAdminCalls, [{ perm: 'broadcast' }], 'auth ran first with the broadcast scope');
  assert.equal(calls.inserts.length, 0, 'NO broadcast row inserted');
  assert.equal(broadcastRows.length, 0, 'fake DB saw no rows');
  assert.equal(calls.notifInserts.length + calls.queueInserts.length, 0, 'nothing enqueued');
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-06 — maintenance trusted path: flags still set AND still honored
// ═══════════════════════════════════════════════════════════════════════════

test('RF-06: maintenance path — createDedupBroadcast still persists BOTH reserved flags and processBroadcastFull still honors them', async () => {
  // (a) The REAL createDedupBroadcast receives exactly the metadata shape
  //     maintenanceStartNotification / maintenanceNotificationTick build
  //     (server-side, hardcoded — never request input).
  const calls = { inserts: [] };
  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    isDatabaseConfigured: () => true,
    queryDb: async (env, sql, params) => {
      calls.inserts.push({ sql: sql.trim(), params });
      return { rows: [{ id: 31337 }] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CREATE_DEDUP_BROADCAST_SRC, sandbox, { filename: 'np.js#createDedupBroadcast' });

  const id = await sandbox.createDedupBroadcast({ env: true }, {
    adminId: 'system',
    title: '🔧 شروع تعمیرات برنامه‌ریزی‌شده',
    message: 'سرویس موقتاً در دسترس نیست',
    category: 'system',
    priority: 'high',
    channel: 'both',
    target_type: 'all',
    metadata: {
      maintenance_period_id: 'maint_20261020T1200Z',
      maintenance_kind: 'start',
      force_channel: true,
      target_all_users: true,
      dedup_key: 'maint_start_maint_20261020T1200Z',
    },
  });

  assert.equal(id, 31337, 'trusted insert returns the row id');
  assert.equal(calls.inserts.length, 1, 'one atomic INSERT…WHERE NOT EXISTS statement');
  const storedMeta = JSON.parse(calls.inserts[0].params[7]);
  assert.equal(storedMeta.force_channel, true, 'trusted path still persists force_channel=true');
  assert.equal(storedMeta.target_all_users, true, 'trusted path still persists target_all_users=true');
  assert.equal(storedMeta.dedup_key, 'maint_start_maint_20261020T1200Z', 'dedup key intact');
  assert.equal(calls.inserts[0].params[3], 'system', 'maintenance category intact');
  assert.equal(calls.inserts[0].params[4], 'high', 'maintenance priority intact');

  // (b) The persisted maintenance metadata still drives the FORCED behavior:
  //     every started user (incl. pref 'none' / 'mini_app' and a user who
  //     never joined the channel) on BOTH channels, full-users audience.
  const users = ['u-none', 'u-mini', 'u-notifoff', 'u-nochannel', 'u-both'];
  const prefs = { 'u-none': 'none', 'u-mini': 'mini_app', 'u-notifoff': 'none', 'u-nochannel': 'both', 'u-both': 'both' };
  const { calls: pcalls } = await runProcessor(
    {
      id: 31337, status: 'pending', last_processed_user_id: null,
      title: '🔧 شروع تعمیرات', message: '...', category: 'system', priority: 'high',
      metadata: storedMeta, // exactly what the trusted path persisted
    },
    users, prefs
  );
  const notifUsers = pcalls.notifInserts.flatMap((i) => i.users);
  const queueUsers = pcalls.queueInserts.flatMap((i) => i.users);
  for (const u of users) {
    assert.ok(queueUsers.includes(u), `${u} still force-enqueued for Telegram (maintenance exception intact)`);
    assert.ok(notifUsers.includes(u), `${u} still gets the in-app copy`);
  }
  assert.ok(pcalls.userQueries.length > 0, 'users query issued');
  for (const sql of pcalls.userQueries) {
    assert.ok(!sql.includes('channel_joined'), 'maintenance audience still targets the FULL users table');
  }
  assert.equal(pcalls.telegramSends, 0, 'still queue-only (no direct sends)');
});

// ═══════════════════════════════════════════════════════════════════════════
// RF-07 — supplementary source pins (fast-fail guards for the boundary split)
// ═══════════════════════════════════════════════════════════════════════════

test('RF-07: the strip lives ONLY in createBroadcast — the trusted path and the read-side are untouched', () => {
  // (a) The public boundary strips both reserved flags.
  assert.match(CREATE_BROADCAST_SRC, /delete _meta\.force_channel/, 'createBroadcast strips force_channel');
  assert.match(CREATE_BROADCAST_SRC, /delete _meta\.target_all_users/, 'createBroadcast strips target_all_users');
  // (b) The trusted maintenance insert has NO strip.
  assert.ok(!/delete .*force_channel/.test(CREATE_DEDUP_BROADCAST_SRC),
    'createDedupBroadcast never deletes the maintenance flags');
  // (c) The read-side still honors the flags from broadcast metadata only.
  assert.match(PROCESS_BROADCAST_FULL_SRC, /_bMeta\.force_channel === true/, 'read-side force_channel check intact');
  assert.match(PROCESS_BROADCAST_FULL_SRC, /_bMeta\.target_all_users === true/, 'read-side target_all_users check intact');
  // (d) worker-proxy still has EXACTLY the 3 maintenance creation sites that
  //     set both flags (unchanged by this fix).
  const flagCount = (WORKER_SRC.match(/force_channel: true/g) || []).length;
  const targetAllCount = (WORKER_SRC.match(/target_all_users: true/g) || []).length;
  assert.equal(flagCount, 3, 'exactly the 3 maintenance creation sites set force_channel');
  assert.equal(targetAllCount, 3, 'exactly the 3 maintenance creation sites set target_all_users');
});

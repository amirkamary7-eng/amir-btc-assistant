/**
 * Regression test for [START-E2E] diagnostic logging + /api/start-diag.
 *
 * Verifies:
 *   1. logStartE2E writes to APP_CACHE KV under key 'start:e2e_log'
 *   2. Rolling buffer caps at 20 entries
 *   3. userId is sanitized (reduced to 4-char suffix, not full ID)
 *   4. No tokens or PII are logged
 *   5. TTL is 1800s
 *   6. Function is non-fatal (never throws)
 *
 * Run: node --test start-e2e-diagnostic-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ============================================================================
// In-memory KV mock (Cloudflare Workers KV API subset)
// ============================================================================

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); this._lastOpts = opts; },
    async delete(key) { store.delete(key); },
    _store: store,
    _lastOpts: null,
  };
}

// ============================================================================
// Extract logStartE2E from worker-proxy.js via source-eval
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Function ${name} not found`);
  const start = m.index;
  let i = start;
  while (i < src.length && src[i] !== '(') i++;
  let parenDepth = 0, inStrP = false, strChP = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStrP) { if (c === '\\') { i++; continue; } if (c === strChP) inStrP = false; }
    else {
      if (c === '"' || c === "'" || c === '`') { inStrP = true; strChP = c; }
      else if (c === '(') parenDepth++;
      else if (c === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }
  }
  while (i < src.length && src[i] !== '{') i++;
  let depth = 0, inStr = false, strCh = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === strCh) inStr = false; }
    else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
  }
  throw new Error(`end of ${name} not found`);
}

const logStartE2E_SRC = extractFn(WORKER_SRC, 'logStartE2E');

function loadLogStartE2E() {
  const exportsObj = {};
  const evaluator = new Function('exports', logStartE2E_SRC + '\nexports.logStartE2E = logStartE2E;');
  evaluator(exportsObj);
  return exportsObj.logStartE2E;
}

const logStartE2E = loadLogStartE2E();

// ============================================================================
// Tests
// ============================================================================

test('LOG-001: logStartE2E writes to APP_CACHE under key start:e2e_log', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'command_detected', userId: '123456789' });
  const raw = kv._store.get('start:e2e_log');
  assert.ok(raw, 'KV must have start:e2e_log key');
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, 'command_detected');
});

test('LOG-002: logStartE2E caps at 20 entries (rolling buffer)', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  for (let i = 0; i < 25; i++) {
    await logStartE2E(env, { phase: `step_${i}`, userId: '111' });
  }
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 20, 'should cap at 20 entries');
  // Oldest 5 should be evicted, newest 20 kept
  assert.equal(entries[0].phase, 'step_5');
  assert.equal(entries[19].phase, 'step_24');
});

test('LOG-003: logStartE2E sanitizes userId (4-char suffix only, no full ID)', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'test', userId: '123456789' });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  // Must NOT contain the full userId
  const entryStr = JSON.stringify(entries[0]);
  assert.ok(!entryStr.includes('123456789'), 'full userId must NOT be logged');
  // Should contain the 4-char suffix
  assert.ok(entries[0].uid, 'should have uid field');
  assert.equal(entries[0].uid, '…6789');
  // Should NOT have userId field
  assert.equal(entries[0].userId, undefined);
});

test('LOG-004: logStartE2E handles short userIds', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'test', userId: '42' });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries[0].uid, '42');
});

test('LOG-005: logStartE2E handles missing userId (no uid field)', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'no_user' });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries[0].uid, undefined);
  assert.equal(entries[0].userId, undefined);
});

test('LOG-006: logStartE2E sets TTL=1800s on KV put', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'test' });
  assert.ok(kv._lastOpts, 'KV.put must be called with options');
  assert.equal(kv._lastOpts.expirationTtl, 1800, 'TTL must be 1800s (30 min)');
});

test('LOG-007: logStartE2E is non-fatal — never throws', async () => {
  // Even if KV throws, logStartE2E must NOT throw (it would break /start)
  const badKv = {
    get() { throw new Error('KV unavailable'); },
    put() { throw new Error('KV write failed'); },
  };
  const env = { APP_CACHE: badKv };
  // Should not throw
  await logStartE2E(env, { phase: 'test', userId: '123' });
  assert.ok(true, 'logStartE2E did not throw on KV error');
});

test('LOG-008: logStartE2E handles null/undefined env gracefully', async () => {
  // Should not throw
  await logStartE2E(null, { phase: 'test' });
  await logStartE2E(undefined, { phase: 'test' });
  await logStartE2E({}, { phase: 'test' });
  await logStartE2E({ APP_CACHE: null }, { phase: 'test' });
  assert.ok(true, 'handles null/undefined env without throwing');
});

test('LOG-009: logStartE2E does NOT log tokens or secrets', async () => {
  const kv = createMemoryKv();
  const env = {
    APP_CACHE: kv,
    TELEGRAM_BOT_TOKEN: 'SUPER_SECRET_TOKEN_123',
    TELEGRAM_WEBHOOK_SECRET: 'WEBHOOK_SECRET_456',
  };
  await logStartE2E(env, { phase: 'test', userId: '123' });
  const raw = kv._store.get('start:e2e_log');
  // The entry must NOT contain any token or secret values
  assert.ok(!raw.includes('SUPER_SECRET_TOKEN_123'), 'TELEGRAM_BOT_TOKEN must NOT appear in log');
  assert.ok(!raw.includes('WEBHOOK_SECRET_456'), 'TELEGRAM_WEBHOOK_SECRET must NOT appear in log');
});

test('LOG-010: logStartE2E preserves entry data (phase, error, telegram_ok, etc.)', async () => {
  const kv = createMemoryKv();
  const env = { APP_CACHE: kv };
  await logStartE2E(env, {
    phase: 'sendMessage_failed',
    userId: '999',
    telegram_ok: false,
    error: 'Telegram sendMessage failed: 400 Bad Request: WEBAPP_URL_INVALID',
  });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries[0].phase, 'sendMessage_failed');
  assert.equal(entries[0].telegram_ok, false);
  assert.ok(entries[0].error.includes('400'));
  assert.ok(entries[0].ts, 'timestamp must be present');
});

test('LOG-011: logStartE2E appends to existing entries (doesn\'t overwrite)', async () => {
  const kv = createMemoryKv();
  // Pre-populate with an existing entry
  kv._store.set('start:e2e_log', JSON.stringify([
    { ts: '2026-01-01T00:00:00Z', phase: 'old_entry', uid: '…0001' },
  ]));
  const env = { APP_CACHE: kv };
  await logStartE2E(env, { phase: 'new_entry', userId: '222' });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].phase, 'old_entry');
  assert.equal(entries[1].phase, 'new_entry');
});

test('LOG-012: logStartE2E handles corrupted KV data gracefully', async () => {
  const kv = createMemoryKv();
  kv._store.set('start:e2e_log', 'not valid json {{{');
  const env = { APP_CACHE: kv };
  // Should not throw — should start fresh
  await logStartE2E(env, { phase: 'after_corruption', userId: '333' });
  const raw = kv._store.get('start:e2e_log');
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, 'after_corruption');
});

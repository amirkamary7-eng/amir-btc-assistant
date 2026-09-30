/**
 * H4: Dead KV Write Removal Regression Test
 *
 * Verifies that:
 * - ALERTS_EXIST_CACHE_KEY constant is NOT defined in worker-proxy.js
 * - No writeAppCache call writes to 'alerts:active-exists'
 * - The 3-layer alert cache (module → KV list → DB) still works
 * - The deletes for alerts:active-exists are PRESERVED (defense-in-depth)
 * - The alerts:active-list write is PRESERVED (the live cache key)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const ALERTS_REPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'repositories', 'alerts.js'), 'utf8');

// ===== H4: Dead write removed =====

test('H4: ALERTS_EXIST_CACHE_KEY constant is NOT defined', () => {
  assert.ok(!WORKER_SRC.includes("ALERTS_EXIST_CACHE_KEY"),
    'ALERTS_EXIST_CACHE_KEY should be removed from worker-proxy.js');
});

test('H4: No writeAppCache call writes to alerts:active-exists', () => {
  assert.ok(!WORKER_SRC.includes("writeAppCache(env, ALERTS_EXIST_CACHE_KEY"),
    'writeAppCache with ALERTS_EXIST_CACHE_KEY should be removed');
  // Also check no direct string reference
  assert.ok(!WORKER_SRC.includes("writeAppCache(env, 'alerts:active-exists'"),
    'writeAppCache with direct string should not exist');
});

test('H4: alerts:active-list write is PRESERVED (live cache key)', () => {
  assert.ok(WORKER_SRC.includes("ALERTS_LIST_CACHE_KEY"),
    'ALERTS_LIST_CACHE_KEY should still be defined');
  assert.ok(WORKER_SRC.includes("writeAppCache(env, ALERTS_LIST_CACHE_KEY"),
    'writeAppCache for alerts:active-list should still exist');
});

// ===== Defense-in-depth: deletes preserved =====

test('H4: alerts:active-exists DELETE is preserved in worker-proxy.js (defense-in-depth)', () => {
  assert.ok(WORKER_SRC.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'Delete for alerts:active-exists should be preserved in worker-proxy.js bulk processing');
});

test('H4: alerts:active-exists DELETE is preserved in alerts.js (create)', () => {
  assert.ok(ALERTS_REPO_SRC.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'Delete for alerts:active-exists should be preserved in alertRepo.create');
});

// ===== Alert cache architecture intact =====

test('H4: 3-layer cache architecture intact (module → KV list → DB)', () => {
  assert.ok(WORKER_SRC.includes('_alertsIsolateCache'),
    'Module-level cache (Layer 1) should exist');
  assert.ok(WORKER_SRC.includes('ALERTS_LIST_CACHE_KEY'),
    'KV cache key (Layer 2) should exist');
  assert.ok(WORKER_SRC.includes('listActiveForCron'),
    'DB query fallback (Layer 3) should exist');
});

test('H4: runScheduledAlertsBaseline function still exists', () => {
  assert.ok(WORKER_SRC.includes('async function runScheduledAlertsBaseline'),
    'runScheduledAlertsBaseline should exist');
});

test('H4: ALERTS_LIST_TTL is still defined', () => {
  assert.ok(WORKER_SRC.includes('ALERTS_LIST_TTL'),
    'ALERTS_LIST_TTL should still be defined');
});

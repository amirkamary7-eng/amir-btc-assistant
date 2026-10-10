/**
 * MK-12 — Alert cache & audit trail: symmetric two-layer invalidation on claim
 * =============================================================================
 *
 * Task 62 finding MK-12 (partially confirmed):
 *   VERIFIED SAFE (pinned here): markTriggeredBulk is a CAS
 *   (UPDATE ... WHERE status='active' RETURNING id) — re-claim is impossible;
 *   the audit trail (triggered_at, last_trigger_price) is written ONLY inside
 *   the CAS; the periodic working-columns bulk UPDATE touches only
 *   last_price/last_checked_at; duplicate notifications are impossible
 *   (deterministic notif ids + ON CONFLICT DO NOTHING + claimed gating).
 *
 *   CONFIRMED GAP (fixed here): STEP 7 invalidated ONLY the KV keys on claim.
 *   The module-level isolate cache (_alertsIsolateCache, 60s TTL) kept the
 *   just-triggered alerts, so within the cron-jitter window (next tick <60s
 *   on the SAME isolate) they were re-processed: wasted OHLC subrequests +
 *   no-op CAS/INSERTs. No user harm — measurable waste.
 *
 * FIX: STEP 7 now clears _alertsIsolateCache/_alertsIsolateCacheAt under the
 * same only-if-claimed condition → symmetric two-layer invalidation; the next
 * tick reads the fresh DB list (triggered alerts excluded by status='active').
 *
 * Run: node --test tests/mk12-alert-cache-audit-trail-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const ALERTS_REPO_SRC = fs.readFileSync(path.join(ROOT, 'src/repositories/alerts.js'), 'utf8');

// ============================================================================
// Extraction
// ============================================================================
// The STEP 7 if-block (only-if-claimed invalidation)
function extractStep7Block() {
  const lines = WORKER_SRC.split('\n');
  const marker = lines.findIndex(l => l.includes('STEP 7: Cache invalidation'));
  if (marker === -1) throw new Error('STEP 7 marker not found');
  let startIdx = -1;
  for (let i = marker; i < lines.length; i++) {
    if (lines[i].trim() === 'if (claimedAlerts.length > 0) {') { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('STEP 7 if-block not found');
  let depth = 0, endIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0 && i > startIdx) { endIdx = i; break; }
  }
  if (endIdx === -1) throw new Error('STEP 7 block end not found');
  return lines.slice(startIdx, endIdx + 1).join('\n');
}
const STEP7_BLOCK = extractStep7Block();

// Real markTriggeredBulk via source evaluation of the alerts repository factory
function loadAlertsRepo(queryDbImpl) {
  const transformed = ALERTS_REPO_SRC.replace(/^export function /m, 'function ');
  const factoryName = (transformed.match(/function (create\w+)\(/) || [])[1];
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'console',
    transformed + `\nmodule.exports.${factoryName} = ${factoryName};`);
  wrapper(moduleObj, moduleObj.exports, { warn: () => {}, log: () => {}, error: () => {} });
  const factory = moduleObj.exports[factoryName];
  return factory({ queryDb: queryDbImpl });
}

// STEP 7 runner with module-state injection
function runStep7({ cache, cacheAt, claimed, kvDeletes }) {
  const env = { APP_CACHE: { delete: (k) => kvDeletes.push(k) } };
  const wrapper = [
    'let _alertsIsolateCache = __g.cache;',
    'let _alertsIsolateCacheAt = __g.cacheAt;',
    'function __step7(claimedAlerts, env) {',
    STEP7_BLOCK,
    '}',
    'return { __step7, __getCache: () => _alertsIsolateCache, __getCacheAt: () => _alertsIsolateCacheAt };',
  ].join('\n');
  const sb = new Function('__g', wrapper)({ cache, cacheAt });
  sb.__step7(claimed, env);
  return { cache: sb.__getCache(), cacheAt: sb.__getCacheAt() };
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-12 S1: on claim, BOTH cache layers are invalidated (KV + module isolate)', () => {
  const kvDeletes = [];
  const { cache, cacheAt } = runStep7({
    cache: [{ id: 'a1', symbol: 'BTC' }, { id: 'a2', symbol: 'ETH' }],
    cacheAt: Date.now(),
    claimed: [{ alertId: 'a1', claimed: true, triggerPrice: 62000 }],
    kvDeletes,
  });
  assert.deepEqual(kvDeletes.sort(), ['alerts:active-exists', 'alerts:active-list'],
    'KV layer invalidated');
  assert.equal(cache, null, 'isolate cache DROPPED (pre-fix: kept until TTL)');
  assert.equal(cacheAt, 0, 'isolate cache timestamp reset');
});

test('MK-12 S2: no claim → NO invalidation of either layer', () => {
  const kvDeletes = [];
  const stale = [{ id: 'a1', symbol: 'BTC' }];
  const staleAt = Date.now();
  const { cache, cacheAt } = runStep7({
    cache: stale, cacheAt: staleAt,
    claimed: [], // markTriggeredBulk returned nothing claimed
    kvDeletes,
  });
  assert.equal(kvDeletes.length, 0, 'no KV deletes without a claim');
  assert.equal(cache, stale, 'isolate cache preserved (nothing to invalidate)');
  assert.equal(cacheAt, staleAt);
});

test('MK-12 S3: REAL markTriggeredBulk CAS — first caller claims, second sees already-triggered', async () => {
  // Mock DB with one active alert; UPDATE ... WHERE status='active' RETURNING id
  const db = { a1: { status: 'active' } };
  const repo = loadAlertsRepo(async (env, sql, params) => {
    const returning = [];
    for (let i = 0; i < params.length; i += 2) { // params = [id, price] pairs (0-based)
      const id = String(params[i]);
      if (db[id] && db[id].status === 'active') {
        db[id].status = 'triggered'; // the UPDATE happens
        returning.push({ id });
      }
    }
    assert.match(sql, /WHERE id IN \(.*\) AND status = 'active'/, 'CAS WHERE clause required');
    return { rows: returning };
  });

  const first = await repo.markTriggeredBulk({}, [{ alertId: 'a1', triggerPrice: 62000 }]);
  assert.equal(first[0].claimed, true, 'first invocation claims the active alert');
  const second = await repo.markTriggeredBulk({}, [{ alertId: 'a1', triggerPrice: 62000 }]);
  assert.equal(second[0].claimed, false, 'second invocation cannot re-claim (CAS guard)');
});

test('MK-12 S4: post-claim next tick (same isolate, <60s) re-reads the fresh DB list — no re-processing', () => {
  // Simulate the two-tick sequence on one isolate.
  const kvDeletes = [];
  // Tick 1: isolate cache has [a1, a2]; a1 triggers and is claimed.
  const state = { cache: [{ id: 'a1' }, { id: 'a2' }], cacheAt: Date.now() };
  const afterTick1 = runStep7({ ...state, claimed: [{ alertId: 'a1', claimed: true, triggerPrice: 1 }], kvDeletes });
  assert.equal(afterTick1.cache, null, 'tick 1 dropped the isolate copy');
  // Tick 2 (<60s later, same isolate): layer-1 read finds NO fresh cache entry
  // → falls through to KV (also invalidated) → DB fresh list, which EXCLUDES
  // the triggered a1 (status='active' filter — pinned in S5).
  const freshDbList = [{ id: 'a2' }]; // what the DB returns for active alerts
  const reprocessed = afterTick1.cache ?? freshDbList;
  assert.equal(reprocessed, freshDbList, 'tick 2 processed the FRESH list, not the stale isolate copy');
  assert.ok(!reprocessed.some(a => a.id === 'a1'), 'the triggered alert is NOT re-processed');
});

test('MK-12 S5 (source pins): audit-trail columns are written ONLY inside the CAS', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const repo = strip(ALERTS_REPO_SRC);
  const mtb = repo.slice(repo.indexOf('async function markTriggeredBulk'), repo.indexOf('async function getActiveAlertsBulk'));

  // CAS structure: status/triggered_at/last_trigger_price SET + WHERE status='active' + RETURNING
  assert.match(mtb, /SET status = 'triggered',/, 'status written inside the CAS');
  assert.match(mtb, /triggered_at = NOW\(\)/, 'audit timestamp written inside the CAS');
  assert.match(mtb, /AND status = 'active'/, 'guarded by the active-status CAS predicate');
  assert.match(mtb, /RETURNING id/, 'claim proven by RETURNING');

  // The active list excludes triggered alerts (listActiveForCron)
  assert.match(repo.slice(repo.indexOf('async function listActiveForCron'), repo.indexOf('async function listActiveForCron') + 2500),
    /status = 'active'/, 'active-list query filters status=active (triggered alerts excluded)');

  // The periodic working-columns bulk UPDATE must NOT touch the audit trail
  // (locate by the actual SQL — the section marker is a // comment)
  const worker = strip(WORKER_SRC);
  const bulkUpdateIdx = worker.indexOf('UPDATE price_alerts SET last_price = CASE id');
  assert.notEqual(bulkUpdateIdx, -1, 'periodic bulk UPDATE SQL must exist');
  const bulkUpdateZone = worker.slice(Math.max(0, bulkUpdateIdx - 600), bulkUpdateIdx + 1200);
  assert.match(bulkUpdateZone, /SET last_price = CASE id/, 'working column last_price only');
  assert.match(bulkUpdateZone, /last_checked_at = NOW\(\)/, 'working column last_checked_at only');
  assert.ok(!bulkUpdateZone.includes('triggered_at'), 'periodic UPDATE must never write triggered_at');
  assert.ok(!/SET status/.test(bulkUpdateZone), 'periodic UPDATE must never change status');

  // STEP 7 clears both layers under the only-if-claimed condition
  const step7 = strip(STEP7_BLOCK);
  assert.match(step7, /if \(claimedAlerts\.length > 0\)/, 'only-if-claimed guard');
  assert.match(step7, /_alertsIsolateCache = null/, 'isolate cache dropped');
  assert.match(step7, /_alertsIsolateCacheAt = 0/, 'isolate timestamp reset');
});

test('MK-12 S6: isolate cache TTL is bounded at 60s and the layer-1 read enforces the age', () => {
  assert.match(WORKER_SRC, /const _ALERTS_ISOLATE_CACHE_TTL_MS = 60 \* 1000/, '60s TTL constant');
  const readZone = WORKER_SRC.slice(
    WORKER_SRC.indexOf('Layer 1: Module-level Map (_alertsIsolateCache)'),
    WORKER_SRC.indexOf('Layer 3: Database (source of truth)')
  );
  assert.match(readZone, /isolateCacheAge < _ALERTS_ISOLATE_CACHE_TTL_MS/, 'age gate enforced on read');
  const ttlMatches = (WORKER_SRC.match(/_ALERTS_ISOLATE_CACHE_TTL_MS = [^;]+;/g) || []).length;
  assert.equal(ttlMatches, 1, 'exactly one TTL definition');
});

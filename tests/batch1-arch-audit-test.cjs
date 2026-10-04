/**
 * Batch 1 — Architecture Audit Fix Regression Tests
 *
 * Verifies the 4 fixes from Batch 1:
 *   1. Alert Create rate limit (isUserRateLimited, 10/60s)
 *   2. m2m100 translation timeout (15s Promise.race)
 *   3. Admin ID inconsistency fix (isSuperAdmin delegates to isAdminTelegramId)
 *   4. Calendar broadcast user-count cap (batching, no drop)
 *
 * Run: node --test tests/batch1-arch-audit-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const ALERTS_CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/alerts.js'), 'utf8');
const ADMIN_REPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/admin.js'), 'utf8');
const TRANSLATE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/translate.js'), 'utf8');

// ============================================================================
// FIX 1 — Alert Create Rate Limit
// ============================================================================

test('1a. handleCreate has isUserRateLimited in deps', () => {
  assert.match(ALERTS_CTRL_SRC, /isUserRateLimited/, 'alerts controller must receive isUserRateLimited in deps');
});

test('1b. handleCreate checks rate limit (10/60s, category alert-create)', () => {
  const fnStart = ALERTS_CTRL_SRC.indexOf('async function handleCreate');
  assert.ok(fnStart > -1, 'handleCreate must exist');
  const fnEnd = ALERTS_CTRL_SRC.indexOf('\n  }', fnStart);
  const fnBody = ALERTS_CTRL_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : ALERTS_CTRL_SRC.length);
  assert.match(fnBody, /isUserRateLimited\(env,\s*String\(authState\.user\.id\),\s*['"]alert-create['"],\s*10,\s*60\)/,
    'handleCreate must call isUserRateLimited(env, userId, "alert-create", 10, 60)');
  assert.match(fnBody, /status:\s*429/, 'handleCreate must return 429 on rate limit');
  assert.match(fnBody, /RATE_LIMITED/, 'handleCreate rate-limit response must include code RATE_LIMITED');
});

test('1c. worker-proxy.js injects isUserRateLimited into createAlertHandlers', () => {
  assert.match(WORKER_SRC, /createAlertHandlers\(\{[^}]*isUserRateLimited/s,
    'worker-proxy.js must inject isUserRateLimited into createAlertHandlers');
});

test('1d. rate limit checked AFTER auth but BEFORE body parsing', () => {
  const fnStart = ALERTS_CTRL_SRC.indexOf('async function handleCreate');
  const fnBody = ALERTS_CTRL_SRC.slice(fnStart, ALERTS_CTRL_SRC.indexOf('\n  }', fnStart));
  const authIdx = fnBody.indexOf('authState.error');
  const rlIdx = fnBody.indexOf('isUserRateLimited');
  const bodyIdx = fnBody.indexOf('readJsonBody');
  assert.ok(authIdx > -1 && rlIdx > -1 && bodyIdx > -1, 'all three must exist');
  assert.ok(authIdx < rlIdx, 'auth must come before rate-limit check');
  assert.ok(rlIdx < bodyIdx, 'rate-limit check must come before body parsing');
});

test('1e. rate limit independent of economy', () => {
  const fnStart = ALERTS_CTRL_SRC.indexOf('async function handleCreate');
  const rlIdx = ALERTS_CTRL_SRC.indexOf('isUserRateLimited', fnStart);
  const prefix = ALERTS_CTRL_SRC.slice(fnStart, rlIdx);
  assert.doesNotMatch(prefix, /alertEconomyRepo\.checkQuota|economyService\.debitUser|claimFreeSlot/,
    'economy/quota/debit logic must NOT appear before the rate-limit check');
});

// ============================================================================
// FIX 2 — m2m100 Timeout
// ============================================================================

test('2a. m2m100 call wrapped in Promise.race with 15s timeout', () => {
  const aiRunIdx = TRANSLATE_SRC.indexOf("env.AI.run('@cf/meta/m2m100-1.2b'");
  assert.ok(aiRunIdx > -1, 'm2m100 env.AI.run call must exist');
  const before = TRANSLATE_SRC.slice(Math.max(0, aiRunIdx - 200), aiRunIdx);
  assert.match(before, /Promise\.race\(\[/, 'Promise.race([ must appear before the m2m100 AI.run call');
  const after = TRANSLATE_SRC.slice(aiRunIdx, aiRunIdx + 300);
  assert.match(after, /15000/, 'm2m100 timeout must be 15000ms (15s)');
  assert.match(after, /m2m100 timeout/, 'timeout error message must mention m2m100');
});

test('2b. m2m100 timeout falls to catch → retryable failure → Google fallback', () => {
  const raceIdx = TRANSLATE_SRC.indexOf('Promise.race([');
  const m2m100RaceIdx = TRANSLATE_SRC.indexOf('m2m100', raceIdx > -1 ? raceIdx : 0);
  assert.ok(m2m100RaceIdx > -1, 'm2m100 Promise.race must exist');
  const catchAfterRace = TRANSLATE_SRC.indexOf('catch (e)', m2m100RaceIdx);
  assert.ok(catchAfterRace > -1 && catchAfterRace - m2m100RaceIdx < 2000,
    'a catch block must follow the m2m100 Promise.race');
  const catchBody = TRANSLATE_SRC.slice(catchAfterRace, Math.min(catchAfterRace + 800, TRANSLATE_SRC.length));
  assert.match(catchBody, /recordCircuitResult|Google|fallback|fall through/i,
    'catch must record failure + fall through to Google Translate');
});

test('2c. Gemini DB gateway already has 8s pool-level timeout (no redundant timeout)', () => {
  assert.match(WORKER_SRC, /const DB_QUERY_TIMEOUT_MS\s*=\s*8000/, 'DB_QUERY_TIMEOUT_MS must be 8000 (8s)');
  assert.match(WORKER_SRC, /_poolQueryWithTimeout[\s\S]*?Promise\.race/, '_poolQueryWithTimeout must use Promise.race');
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/assistant.js'), 'utf8');
  const geminiStart = ASSISTANT_SRC.indexOf('async function callGeminiChat');
  const geminiEnd = ASSISTANT_SRC.indexOf('\n  }', geminiStart);
  const geminiBody = ASSISTANT_SRC.slice(geminiStart, geminiEnd > geminiStart ? geminiEnd : ASSISTANT_SRC.length);
  assert.match(geminiBody, /queryDb\(env,\s*`SELECT public\.gemini_generate/, 'callGeminiChat uses queryDb');
  assert.doesNotMatch(geminiBody, /Promise\.race/, 'callGeminiChat must NOT add redundant Promise.race');
});

// ============================================================================
// FIX 3 — Admin ID Inconsistency
// ============================================================================

test('3a. isSuperAdmin delegates to isAdminTelegramId', () => {
  const fnStart = ADMIN_REPO_SRC.indexOf('function isSuperAdmin');
  assert.ok(fnStart > -1, 'isSuperAdmin must exist');
  const fnEnd = ADMIN_REPO_SRC.indexOf('\n  }', fnStart);
  const fnBody = ADMIN_REPO_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : ADMIN_REPO_SRC.length);
  assert.match(fnBody, /typeof isAdminTelegramId === 'function'/, 'isSuperAdmin must check isAdminTelegramId injection');
  assert.match(fnBody, /return isAdminTelegramId\(env, telegramId\)/, 'isSuperAdmin must delegate to isAdminTelegramId');
});

test('3b. isSuperAdmin has defensive fallback', () => {
  const fnStart = ADMIN_REPO_SRC.indexOf('function isSuperAdmin');
  const fnEnd = ADMIN_REPO_SRC.indexOf('\n  }', fnStart);
  const fnBody = ADMIN_REPO_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : ADMIN_REPO_SRC.length);
  assert.match(fnBody, /normalizeOptionalString\(env\.ADMIN_TELEGRAM_ID\)/, 'must have fallback');
});

test('3c. worker-proxy.js injects isAdminTelegramId into createAdminRepository', () => {
  assert.match(WORKER_SRC, /createAdminRepository\(\{[^}]*isAdminTelegramId/s,
    'worker-proxy.js must inject isAdminTelegramId');
});

test('3d. adminRepo deps include isAdminTelegramId', () => {
  assert.match(ADMIN_REPO_SRC, /const \{[^}]*isAdminTelegramId[^}]*\}\s*=\s*deps/, 'admin repo deps must include isAdminTelegramId');
});

test('3e. behavioral: isSuperAdmin with injected isAdminTelegramId', () => {
  const src = ADMIN_REPO_SRC.replace(/^export\s+function\s+createAdminRepository/m, 'function createAdminRepository');
  const moduleObj = { exports: {} };
  const evaluator = new Function('module', 'exports', 'console',
    src + '\nmodule.exports.createAdminRepository = createAdminRepository;');
  evaluator(moduleObj, moduleObj.exports, { warn: () => {}, log: () => {}, error: () => {} });
  const createAdminRepository = moduleObj.exports.createAdminRepository;
  const adminIds = new Set(['111', '222']);
  const isAdminTelegramId = (env, id) => adminIds.has(String(id));
  const repo = createAdminRepository({
    queryDb: async () => ({ rows: [], rowCount: 0 }),
    queryDbDirect: async () => ({ rows: [], rowCount: 0 }),
    normalizeOptionalString: (v) => (v ? String(v).trim() : null),
    isAdminTelegramId,
  });
  const env = { ADMIN_TELEGRAM_ID: '111', ADMIN_TELEGRAM_IDS: '222' };
  assert.equal(repo.isSuperAdmin(env, '111'), true, 'ID in ADMIN_TELEGRAM_ID → true');
  assert.equal(repo.isSuperAdmin(env, '222'), true, 'ID in ADMIN_TELEGRAM_IDS → true (BUG-1 fixed)');
  assert.equal(repo.isSuperAdmin(env, '999'), false, 'Non-admin ID → false');
});

test('3f. behavioral: fallback without injected isAdminTelegramId', () => {
  const src = ADMIN_REPO_SRC.replace(/^export\s+function\s+createAdminRepository/m, 'function createAdminRepository');
  const moduleObj = { exports: {} };
  const evaluator = new Function('module', 'exports', 'console',
    src + '\nmodule.exports.createAdminRepository = createAdminRepository;');
  evaluator(moduleObj, moduleObj.exports, { warn: () => {}, log: () => {}, error: () => {} });
  const createAdminRepository = moduleObj.exports.createAdminRepository;
  const repo = createAdminRepository({
    queryDb: async () => ({ rows: [], rowCount: 0 }),
    queryDbDirect: async () => ({ rows: [], rowCount: 0 }),
    normalizeOptionalString: (v) => (v ? String(v).trim() : null),
  });
  const env = { ADMIN_TELEGRAM_ID: '111', ADMIN_TELEGRAM_IDS: '222' };
  assert.equal(repo.isSuperAdmin(env, '111'), true, 'fallback: ID in ADMIN_TELEGRAM_ID → true');
  assert.equal(repo.isSuperAdmin(env, '222'), false, 'fallback: ID only in ADMIN_TELEGRAM_IDS → false (legacy)');
});

// ============================================================================
// FIX 4 — Calendar Broadcast Cap
// ============================================================================

test('4a. calendar broadcast notif INSERT batched (for-loop, 500/batch)', () => {
  assert.match(WORKER_SRC, /const CALENDAR_BROADCAST_BATCH_SIZE\s*=\s*500/, 'batch size must be 500');
  assert.ok(WORKER_SRC.includes('for (let bi = 0; bi < miniAppUsers.length'), 'notif INSERT must be batched via for-loop');
});

test('4b. calendar broadcast queue INSERT also batched', () => {
  assert.ok(WORKER_SRC.includes('for (let qi = 0; qi < telegramUsers.length'), 'queue INSERT must be batched via for-loop');
});

test('4c. no users dropped — ALL miniAppUsers processed', () => {
  assert.match(WORKER_SRC, /for \(let bi = 0; bi < miniAppUsers\.length; bi \+= CALENDAR_BROADCAST_BATCH_SIZE\) \{[\s\S]*?miniAppUsers\.slice\(bi, bi \+ CALENDAR_BROADCAST_BATCH_SIZE\)/,
    'notif batch loop must iterate over ALL miniAppUsers');
});

test('4d. dedup key written AFTER all batches', () => {
  const lastBatchEnd = WORKER_SRC.lastIndexOf('CALENDAR_BROADCAST_BATCH_SIZE');
  const dedupIdx = WORKER_SRC.indexOf('writeAppCache(env, dedupKey', lastBatchEnd);
  assert.ok(dedupIdx > -1, 'dedup key write must exist after batch loops');
  assert.ok(dedupIdx > lastBatchEnd, 'dedup key write must be AFTER the last batch reference');
});

test('4e. batch failure sets notifInsertOk/queueInsertOk false', () => {
  assert.ok(WORKER_SRC.includes('notifInsertOk = false'), 'notif batch failure must set notifInsertOk = false');
  assert.ok(WORKER_SRC.includes('queueInsertOk = false'), 'queue batch failure must set queueInsertOk = false');
});

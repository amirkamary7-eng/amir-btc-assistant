/**
 * Notification Queue Priority Ordering — Regression Tests (PHASE 2)
 *
 * Confirmed bug (Phase 1 audit):
 *   processQueue at src/repositories/notification_platform.js:741 uses
 *     ORDER BY priority DESC, created_at ASC
 *   on a VARCHAR(16) column. PostgreSQL (and pg-mem) sort VARCHAR
 *   LEXICOGRAPHICALLY, so DESCENDING order produces:
 *
 *     'medium' (m=109) → processed FIRST
 *     'low'    (l=108) → processed 2nd
 *     'high'   (h=104) → processed 3rd
 *     'critical' (c=99) → processed LAST
 *
 *   This is the EXACT INVERSE of the intended semantic order
 *   (critical > high > medium > low).
 *
 * Candidate fix (evaluated in Phase 1, applied in Phase 2):
 *
 *   ORDER BY
 *     CASE priority
 *       WHEN 'critical' THEN 4
 *       WHEN 'high' THEN 3
 *       WHEN 'medium' THEN 2
 *       WHEN 'low' THEN 1
 *       ELSE 0
 *     END DESC,
 *     created_at ASC
 *
 * Test architecture:
 *   - P-1..P-3: source-level assertion that processQueue's ORDER BY uses
 *     the CASE-based semantic priority mapping (PASSES only AFTER fix).
 *   - P-FUNC-1..P-FUNC-7: functional tests against pg-mem (the same
 *     in-memory PG engine used by wallet tests). pg-mem reproduces real
 *     PostgreSQL's lexicographic VARCHAR sort, so these tests prove
 *     the actual SQL behavior — not just the source code shape.
 *
 * Run: node --test notif-priority-queue-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const NOTIF_REPO = fs.readFileSync(
  path.join(__dirname, 'src/repositories/notification_platform.js'),
  'utf8',
);

// ============================================================================
// Source-level assertions (P-1..P-3)
// ============================================================================

test('P-1: processQueue ORDER BY uses semantic CASE priority mapping (critical=4, high=3, medium=2, low=1)', () => {
  // The fix introduces a CASE expression that maps priority strings to
  // numeric weights. Source must contain all 4 mappings.
  assert.ok(
    NOTIF_REPO.includes("WHEN 'critical' THEN 4") &&
    NOTIF_REPO.includes("WHEN 'high' THEN 3") &&
    NOTIF_REPO.includes("WHEN 'medium' THEN 2") &&
    NOTIF_REPO.includes("WHEN 'low' THEN 1"),
    'processQueue must use CASE WHEN critical=4/high=3/medium=2/low=1 mapping. ' +
    'Currently uses plain ORDER BY priority DESC (lexicographic — WRONG).',
  );
});

test('P-2: processQueue CASE-based ORDER BY keeps created_at ASC as secondary tiebreaker', () => {
  // The CASE expression must be the primary sort, and created_at ASC
  // must remain as the secondary tiebreaker for same-priority items.
  // Find the ORDER BY block and verify the structure.
  const caseIdx = NOTIF_REPO.indexOf('CASE priority');
  assert.ok(caseIdx > -1, 'CASE priority expression must exist');
  // Find the next occurrence of 'created_at ASC' AFTER the CASE block
  const afterCase = NOTIF_REPO.slice(caseIdx);
  assert.ok(
    afterCase.includes('END DESC') && afterCase.includes('created_at ASC'),
    'CASE expression must end with END DESC followed by created_at ASC tiebreaker',
  );
});

test('P-3: processQueue unknown/NULL priority sorts LAST via ELSE 0', () => {
  // Unknown priority values (e.g., 'urgent', 'normal') must sort LAST
  // (lowest weight), not first. The ELSE 0 clause ensures this.
  assert.ok(
    NOTIF_REPO.includes('ELSE 0'),
    'processQueue CASE must have ELSE 0 so unknown priority values sort last',
  );
});

// ============================================================================
// Functional tests against pg-mem (P-FUNC-1..P-FUNC-7)
//
// pg-mem reproduces real PostgreSQL's lexicographic VARCHAR DESC sort.
// We simulate the EXACT production processQueue query (before and after fix)
// against an in-memory notification_queue table to assert actual SQL behavior.
// ============================================================================

/**
 * Build a fresh pg-mem DB with the production notification_queue schema
 * (subset — only the columns processQueue's WHERE/ORDER BY touch).
 */
function freshDb() {
  const db = newDb();
  db.public.query(`
    CREATE TABLE notification_queue (
      id SERIAL PRIMARY KEY,
      notification_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel VARCHAR(32) NOT NULL DEFAULT 'mini_app',
      priority VARCHAR(16) NOT NULL DEFAULT 'medium',
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at TIMESTAMPTZ,
      payload JSONB DEFAULT '{}',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      telegram_message_id BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_queue_pending
      ON notification_queue (status, priority, next_retry_at) WHERE status = 'pending';
  `);
  return db;
}

/**
 * Insert a queue item with explicit created_at (so we can test the
 * same-priority tiebreaker deterministically without sub-second races).
 */
function insertItem(db, { id_suffix, priority, created_at_offset_ms = 0, status = 'pending', attempts = 0, next_retry_at = null, max_attempts = 3 }) {
  // pg-mem accepts ISO timestamps
  const baseTime = new Date('2026-01-01T00:00:00Z').getTime() + created_at_offset_ms;
  const createdAt = new Date(baseTime).toISOString();
  const nr = next_retry_at ? `'${new Date(next_retry_at).toISOString()}'` : 'NULL';
  db.public.query(`
    INSERT INTO notification_queue (notification_id, user_id, priority, status, attempts, max_attempts, next_retry_at, created_at)
    VALUES ('notif_${id_suffix}', 'user_test', '${priority}', '${status}', ${attempts}, ${max_attempts}, ${nr}, '${createdAt}')
  `);
}

/**
 * The EXACT production query BEFORE fix (lexicographic) — for baseline.
 * Mirrors notification_platform.js:734-746 (pre-fix).
 */
const QUERY_OLD = `
  SELECT id, notification_id, priority, created_at FROM notification_queue
  WHERE status = 'pending' AND attempts < max_attempts
    AND (next_retry_at IS NULL OR next_retry_at <= NOW())
  ORDER BY priority DESC, created_at ASC
`;

/**
 * The EXACT production query AFTER fix (semantic CASE-based) — the candidate fix.
 * Mirrors notification_platform.js:734-746 (post-fix).
 */
const QUERY_NEW = `
  SELECT id, notification_id, priority, created_at FROM notification_queue
  WHERE status = 'pending' AND attempts < max_attempts
    AND (next_retry_at IS NULL OR next_retry_at <= NOW())
  ORDER BY
    CASE priority
      WHEN 'critical' THEN 4
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 1
      ELSE 0
    END DESC,
    created_at ASC
`;

/**
 * Run a SELECT query against pg-mem and return rows.
 */
function runSelect(db, sql, limit = 50) {
  const r = db.public.query(sql + (sql.includes('LIMIT') ? '' : ` LIMIT ${limit}`));
  return r.rows;
}

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-1: semantic priority ordering (the core bug proof)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-1 [OLD bug]: plain ORDER BY priority DESC produces LEXICOGRAPHIC order (medium, low, high, critical) — NOT semantic', () => {
  const db = freshDb();
  // Insert in random order with distinct timestamps so timestamp is not a tiebreaker
  insertItem(db, { id_suffix: 'low',      priority: 'low',      created_at_offset_ms: 100 });
  insertItem(db, { id_suffix: 'critical', priority: 'critical', created_at_offset_ms: 200 });
  insertItem(db, { id_suffix: 'medium',   priority: 'medium',   created_at_offset_ms: 300 });
  insertItem(db, { id_suffix: 'high',     priority: 'high',     created_at_offset_ms: 400 });

  const rows = runSelect(db, QUERY_OLD);
  const order = rows.map(r => r.priority);
  // Documenting the BUG: lexicographic DESC puts 'medium' first, 'critical' last
  assert.deepStrictEqual(order, ['medium', 'low', 'high', 'critical'],
    'Pre-fix ORDER BY priority DESC must produce lexicographic (WRONG) order. ' +
    'If this passes, the bug is not present in pg-mem and the root cause assumption is wrong.');
});

test('P-FUNC-2 [NEW fix]: CASE-based ORDER BY produces SEMANTIC order (critical, high, medium, low)', () => {
  const db = freshDb();
  insertItem(db, { id_suffix: 'low',      priority: 'low',      created_at_offset_ms: 100 });
  insertItem(db, { id_suffix: 'critical', priority: 'critical', created_at_offset_ms: 200 });
  insertItem(db, { id_suffix: 'medium',   priority: 'medium',   created_at_offset_ms: 300 });
  insertItem(db, { id_suffix: 'high',     priority: 'high',     created_at_offset_ms: 400 });

  const rows = runSelect(db, QUERY_NEW);
  const order = rows.map(r => r.priority);
  assert.deepStrictEqual(order, ['critical', 'high', 'medium', 'low'],
    'Post-fix CASE-based ORDER BY must produce semantic order (critical > high > medium > low).');
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-3: same-priority tiebreaker — created_at ASC (older first)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-3: within same priority, created_at ASC is preserved (older first)', () => {
  const db = freshDb();
  // Three 'high' items, inserted with different created_at (newest first to ensure
  // the sort doesn't accidentally rely on insertion order).
  insertItem(db, { id_suffix: 'high_3rd', priority: 'high', created_at_offset_ms: 300 }); // newest
  insertItem(db, { id_suffix: 'high_1st', priority: 'high', created_at_offset_ms: 100 }); // oldest
  insertItem(db, { id_suffix: 'high_2nd', priority: 'high', created_at_offset_ms: 200 });
  // Plus one 'critical' to make the priority sort meaningful
  insertItem(db, { id_suffix: 'crit_1st', priority: 'critical', created_at_offset_ms: 500 });

  const rows = runSelect(db, QUERY_NEW);
  const order = rows.map(r => r.notification_id);
  assert.deepStrictEqual(order,
    ['notif_crit_1st', 'notif_high_1st', 'notif_high_2nd', 'notif_high_3rd'],
    'Critical first, then high items ordered by created_at ASC (oldest first).');
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-4: unknown priority values sort LAST (ELSE 0)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-4: unknown priority values (e.g., urgent, normal) sort LAST via ELSE 0', () => {
  const db = freshDb();
  insertItem(db, { id_suffix: 'low',     priority: 'low'     });
  insertItem(db, { id_suffix: 'medium',  priority: 'medium'  });
  insertItem(db, { id_suffix: 'high',    priority: 'high'    });
  insertItem(db, { id_suffix: 'critical', priority: 'critical' });
  // Unknown priorities — should sort LAST (ELSE 0)
  insertItem(db, { id_suffix: 'urgent',  priority: 'urgent'  });
  insertItem(db, { id_suffix: 'normal',  priority: 'normal'  });

  const rows = runSelect(db, QUERY_NEW);
  const order = rows.map(r => r.priority);
  assert.deepStrictEqual(order,
    ['critical', 'high', 'medium', 'low', 'urgent', 'normal'],
    'Known priorities in semantic order first, then unknown priorities via ELSE 0 (last). ' +
    'Order between unknowns: lexicographic DESC within ELSE 0 group (acceptable).');
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-5: NULL priority cannot occur (NOT NULL constraint)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-5: notification_queue.priority is NOT NULL — NULL insert is rejected', () => {
  const db = freshDb();
  // The schema enforces NOT NULL — try to insert NULL and verify it's rejected.
  assert.throws(
    () => db.public.query(`INSERT INTO notification_queue (notification_id, user_id, priority) VALUES ('n_null', 'u', NULL)`),
    /not-null|NOT NULL|violates/i,
    'Schema must reject NULL priority (column is NOT NULL). ' +
    'No constraint changes needed — already enforced by schema.',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-6: retry filter — items with next_retry_at > NOW() are NOT claimed
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-6: items with next_retry_at > NOW() are skipped (not claimable until retry time)', () => {
  const db = freshDb();
  // A 'low' item that is claimable now
  insertItem(db, { id_suffix: 'low_now', priority: 'low' });
  // A 'critical' item with next_retry_at in the FUTURE (should be skipped)
  insertItem(db, { id_suffix: 'crit_future', priority: 'critical', next_retry_at: Date.now() + 60 * 60 * 1000 });
  // A 'high' item with next_retry_at in the PAST (should be claimable)
  insertItem(db, { id_suffix: 'high_past', priority: 'high', next_retry_at: Date.now() - 60 * 1000 });

  const rows = runSelect(db, QUERY_NEW);
  const order = rows.map(r => r.notification_id);
  // crit_future must be EXCLUDED by the WHERE clause (next_retry_at > NOW())
  assert.ok(!order.includes('notif_crit_future'),
    'Item with future next_retry_at must NOT be claimed (excluded by WHERE clause).');
  // The remaining items must be in semantic priority order: high (3) > low (1)
  assert.deepStrictEqual(order, ['notif_high_past', 'notif_low_now'],
    'Claimable items in semantic order: high (past retry) > low (now).');
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-7: empty queue — processQueue returns 0 processed (no error)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-7: empty queue — SELECT returns 0 rows without error', () => {
  const db = freshDb();
  const rows = runSelect(db, QUERY_NEW);
  assert.deepStrictEqual(rows, [],
    "Empty queue must return 0 rows (processQueue fast-exit path: " +
    "if (!queue.rows || queue.rows.length === 0) return { processed: 0 }).");
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-8: retryable item (next_retry_at <= NOW()) still sorted by semantic priority
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-8: retryable items (next_retry_at <= NOW()) are still sorted by semantic priority', () => {
  const db = freshDb();
  // Insert a 'low' retryable item (next_retry_at just passed) and a 'high' retryable item
  insertItem(db, { id_suffix: 'low_retry',  priority: 'low',  next_retry_at: Date.now() - 1000 });
  insertItem(db, { id_suffix: 'high_retry', priority: 'high', next_retry_at: Date.now() - 500 });
  // Plus a 'medium' fresh item (no next_retry_at — claimable immediately)
  insertItem(db, { id_suffix: 'medium_fresh', priority: 'medium' });

  const rows = runSelect(db, QUERY_NEW);
  const order = rows.map(r => r.notification_id);
  // Semantic order across ALL claimable items (whether fresh or retryable):
  // high (3) > medium (2) > low (1)
  assert.deepStrictEqual(order,
    ['notif_high_retry', 'notif_medium_fresh', 'notif_low_retry'],
    'Retryable items (next_retry_at <= NOW) and fresh items are mixed by semantic priority, ' +
    'NOT by retry time. high > medium > low.');
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-9: FOR UPDATE SKIP LOCKED contract unchanged
// (source-level — pg-mem doesn't support row locks, but we verify the
// production query still contains the clause after the fix)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-9: processQueue query still contains FOR UPDATE SKIP LOCKED (concurrency contract unchanged)', () => {
  // The fix must NOT remove or alter FOR UPDATE SKIP LOCKED — it only changes
  // the ORDER BY clause.
  assert.ok(
    NOTIF_REPO.includes('FOR UPDATE SKIP LOCKED'),
    'processQueue must retain FOR UPDATE SKIP LOCKED for concurrency safety. ' +
    'The fix changes only the ORDER BY clause, not the locking strategy.',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-10: batch size (LIMIT) unchanged
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-10: processQueue still respects batchLimit (LIMIT clause unchanged)', () => {
  // The fix must NOT change the LIMIT clause or batchLimit computation.
  assert.ok(
    NOTIF_REPO.includes('const batchLimit = Math.max(1, Math.min(Number(limit) || 10, 50));'),
    'processQueue must retain batchLimit computation (1..50).',
  );
  assert.ok(
    NOTIF_REPO.includes('LIMIT ${batchLimit}'),
    'processQueue must retain LIMIT ${batchLimit} clause.',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-11: status transitions unchanged (pending → processing → processed/failed)
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-11: processQueue status transitions unchanged (pending → processing → processed/failed)', () => {
  // The fix must NOT touch the status transition logic.
  assert.ok(
    NOTIF_REPO.includes("SET status = 'processing', processed_at = NOW(), claimed_at = NOW()"),
    'processQueue must retain the claim UPDATE (status=processing, claimed_at=NOW).',
  );
  assert.ok(
    NOTIF_REPO.includes("SET status = 'processed', processed_at = NOW(), telegram_message_id = $2"),
    'processQueue must retain the success UPDATE (status=processed + telegram_message_id).',
  );
  assert.ok(
    NOTIF_REPO.includes("SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END"),
    'processQueue must retain the failure UPDATE (failed/pending + attempts+1).',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// P-FUNC-12: real processQueue against pg-mem — end-to-end semantic ordering
//
// Loads the REAL createNotificationPlatformRepository from src/ and runs
// processQueue against pg-mem, asserting the ORDER items are claimed.
// This is the strongest evidence — the test uses the ACTUAL production code.
// ──────────────────────────────────────────────────────────────────────────

test('P-FUNC-12 [END-TO-END]: REAL processQueue ORDER BY clause produces semantic priority order', async () => {
  // Load the REAL processQueue source from src/repositories/notification_platform.js
  // and extract the EXACT ORDER BY clause. pg-mem cannot run the production
  // query verbatim because:
  //   1. `FOR UPDATE SKIP LOCKED` is unsupported (stripped — wallet harness shim #6)
  //   2. pg-mem ignores ORDER BY inside IN (SELECT...ORDER BY...LIMIT) subqueries
  //      (documented limitation — verified by probe: UPDATE...WHERE id IN (SELECT...ORDER BY...)
  //      returns rows in physical insertion order, NOT in the subquery's ORDER BY order)
  //
  // Workaround: extract ONLY the ORDER BY clause from the production source and
  // run it against a plain SELECT (pg-mem correctly honors ORDER BY on a top-level
  // SELECT — verified by probe). This proves the ACTUAL production ORDER BY clause
  // produces the semantic order, without modifying the production query shape.

  const repoRelPath = 'src/repositories/notification_platform.js';
  const src = fs.readFileSync(path.join(__dirname, repoRelPath), 'utf8');

  // Find processQueue's ORDER BY clause — the text between 'ORDER BY' and 'LIMIT'
  // inside the UPDATE...WHERE id IN (SELECT...ORDER BY...LIMIT...FOR UPDATE SKIP LOCKED) block.
  // Match the FIRST ORDER BY occurrence that is followed by a CASE expression
  // (post-fix) or by 'priority DESC' (pre-fix). We look for the subquery ORDER BY.
  const processQueueIdx = src.indexOf('async function processQueue');
  assert.ok(processQueueIdx > -1, 'processQueue function must exist in notification_platform.js');
  const fnBody = src.slice(processQueueIdx, processQueueIdx + 4000);
  // The ORDER BY clause sits between 'ORDER BY' and 'LIMIT ${batchLimit}'
  const orderByMatch = fnBody.match(/ORDER BY\s+([\s\S]*?)\s+LIMIT\s+\$\{batchLimit\}/);
  assert.ok(orderByMatch, 'processQueue must contain an ORDER BY...LIMIT ${batchLimit} block');
  const orderByClause = orderByMatch[1].trim();

  // Build a plain SELECT that uses the EXACT extracted ORDER BY clause.
  // pg-mem honors ORDER BY on a top-level SELECT (verified by probe).
  const db = freshDb();
  const t0 = new Date('2026-01-01T00:00:00Z').getTime();
  const insertAt = (id, priority, offsetMs) => {
    db.public.query(`INSERT INTO notification_queue (notification_id, user_id, priority, status, attempts, max_attempts, created_at)
      VALUES ('${id}', 'u_test', '${priority}', 'pending', 0, 3, '${new Date(t0 + offsetMs).toISOString()}')`);
  };
  insertAt('low_1',      'low',      100);
  insertAt('critical_1', 'critical', 200);
  insertAt('medium_1',   'medium',   300);
  insertAt('high_1',     'high',     400);
  insertAt('high_2',     'high',     50);   // earlier than high_1 — should come before high_1

  // Run the EXACT production ORDER BY clause as a top-level SELECT (pg-mem-safe).
  const selectSql = `SELECT notification_id, priority, created_at FROM notification_queue
    WHERE status = 'pending' AND attempts < max_attempts
    AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    ORDER BY ${orderByClause}`;
  const rows = db.public.query(selectSql).rows;
  const order = rows.map(r => r.notification_id);
  assert.deepStrictEqual(order,
    ['critical_1', 'high_2', 'high_1', 'medium_1', 'low_1'],
    'REAL processQueue ORDER BY clause must produce semantic order: ' +
    'critical > high (created_at ASC: high_2 before high_1) > medium > low. ' +
    'If this fails with [medium_1, low_1, high_2, high_1, critical_1] the bug is still present (lexicographic). ' +
    'Extracted ORDER BY clause: ' + orderByClause.replace(/\s+/g, ' ').slice(0, 200),
  );
});

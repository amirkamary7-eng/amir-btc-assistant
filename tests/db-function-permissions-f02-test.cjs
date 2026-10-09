/**
 * F-02 REGRESSION TEST — DB Function Permissions (groq_generate_with_key)
 * =====================================================================
 * Finding F-02: scripts/00-migrate.sql unconditionally re-asserted
 *   GRANT EXECUTE ON FUNCTION public.groq_generate_with_key(...) TO PUBLIC
 * on every production deploy (CI runs the migration twice per deploy:
 * atomic + idempotency re-run). PUBLIC covers anon + authenticated — the
 * PostgREST caller roles — so anyone holding the (publishable) anon key
 * could invoke the SECURITY DEFINER Groq WAF-bypass relay with a
 * caller-supplied key (quota abuse from Supabase's egress IP pool).
 *
 * Live-DB evidence (read-only audit, production):
 *   * has_function_privilege('anon'/'authenticated'/'public', ...EXECUTE) = true
 *   * Worker's actual DB role is `amirbtc_worker` (5 active connections).
 *   * Sibling functions groq_generate + gemini_generate were already
 *     restricted to {postgres, service_role, amirbtc_worker} — only
 *     groq_generate_with_key retained the PUBLIC grant.
 *
 * The fix (both SQL files):
 *   * REVOKE EXECUTE ... FROM PUBLIC (idempotent, applies to existing DBs
 *     on the next deploy because 00-migrate.sql runs every deploy).
 *   * Guarded GRANT to amirbtc_worker (DO block checks pg_roles first so
 *     fresh environments without the role don't break the migration).
 *
 * Run: node --test tests/db-function-permissions-f02-test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MIGRATE = fs.readFileSync(path.join(REPO, 'scripts', '00-migrate.sql'), 'utf8');
const GATEWAY_HIST = fs.readFileSync(path.join(REPO, 'scripts', 'groq-gateway-migration.sql'), 'utf8');

const FN = 'public.groq_generate_with_key(text, jsonb, text, integer, double precision)';

// ─── 00-migrate.sql (the CI-wired migration — the live source of truth) ───

test('F02-SRC-001: 00-migrate.sql must NOT grant EXECUTE to PUBLIC on groq_generate_with_key', () => {
  const grantLines = MIGRATE.split('\n')
    .map(l => l.trim())
    .filter(l => !l.startsWith('--'))
    .filter(l => l.includes('GRANT EXECUTE') && l.includes('groq_generate_with_key'));
  assert.ok(grantLines.length > 0, '00-migrate.sql must still GRANT EXECUTE (to a restricted role)');
  for (const l of grantLines) {
    assert.ok(!/\bTO\s+PUBLIC\b/i.test(l), `line grants to PUBLIC: ${l}`);
  }
});

test('F02-SRC-002: 00-migrate.sql must REVOKE EXECUTE FROM PUBLIC on groq_generate_with_key', () => {
  assert.ok(
    MIGRATE.includes(`REVOKE EXECUTE ON FUNCTION ${FN} FROM PUBLIC;`),
    '00-migrate.sql must contain the F-02 REVOKE (idempotent — safe on existing DBs)'
  );
});

test('F02-SRC-003: 00-migrate.sql must grant EXECUTE to amirbtc_worker guarded by a pg_roles existence check', () => {
  // The guarded grant: DO block + IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amirbtc_worker')
  assert.ok(
    /DO\s+\$\w*\$/.test(MIGRATE) &&
    MIGRATE.includes("SELECT 1 FROM pg_roles WHERE rolname = 'amirbtc_worker'") &&
    new RegExp(`GRANT EXECUTE ON FUNCTION ${FN.replace(/\(/g, '\\(').replace(/\)/g, '\\)')} TO amirbtc_worker;`).test(MIGRATE),
    '00-migrate.sql must contain the role-existence-guarded GRANT to amirbtc_worker'
  );
});

test('F02-SRC-004: the REVOKE must come before the guarded GRANT in 00-migrate.sql', () => {
  const revokeIdx = MIGRATE.indexOf(`REVOKE EXECUTE ON FUNCTION ${FN} FROM PUBLIC;`);
  const grantIdx = MIGRATE.indexOf('TO amirbtc_worker;');
  assert.ok(revokeIdx > 0, 'REVOKE present');
  assert.ok(grantIdx > revokeIdx, 'GRANT to amirbtc_worker must follow the REVOKE');
});

test('F02-SRC-005: migration stays safe for environments WITHOUT amirbtc_worker (RAISE NOTICE fallback, no exception)', () => {
  assert.ok(
    /RAISE NOTICE 'F-02: role amirbtc_worker not present — skipping EXECUTE grant';/.test(MIGRATE),
    'the DO block must RAISE NOTICE (not EXCEPTION) when the role is absent'
  );
});

test('F02-SRC-006: fix must not weaken the function definition (SECURITY DEFINER + locked search_path preserved)', () => {
  assert.ok(MIGRATE.includes('CREATE OR REPLACE FUNCTION public.groq_generate_with_key'), 'function definition kept');
  assert.ok(MIGRATE.includes('SECURITY DEFINER'), 'still SECURITY DEFINER');
  assert.ok(MIGRATE.includes("search_path TO 'public', 'vault', 'extensions'"), 'search_path still locked');
});

test('F02-SRC-007: no other GRANT ... TO PUBLIC on any function remains in 00-migrate.sql', () => {
  const bad = MIGRATE.split('\n')
    .map(l => l.trim())
    .filter(l => !l.startsWith('--'))
    .filter(l => /^GRANT/i.test(l) && /\bTO\s+PUBLIC\b/i.test(l));
  assert.deepStrictEqual(bad, [], `unexpected PUBLIC grants: ${bad.join(' | ')}`);
});

// ─── groq-gateway-migration.sql (historical file — must not re-poison if run manually) ───

test('F02-SRC-008: groq-gateway-migration.sql must NOT grant EXECUTE to PUBLIC', () => {
  const bad = GATEWAY_HIST.split('\n')
    .map(l => l.trim())
    .filter(l => !l.startsWith('--'))
    .filter(l => /^GRANT/i.test(l) && /\bTO\s+PUBLIC\b/i.test(l));
  assert.deepStrictEqual(bad, [], `unexpected PUBLIC grants: ${bad.join(' | ')}`);
});

test('F02-SRC-009: groq-gateway-migration.sql carries the same REVOKE + guarded grant', () => {
  assert.ok(GATEWAY_HIST.includes(`REVOKE EXECUTE ON FUNCTION ${FN} FROM PUBLIC;`));
  assert.ok(GATEWAY_HIST.includes("SELECT 1 FROM pg_roles WHERE rolname = 'amirbtc_worker'"));
  assert.ok(GATEWAY_HIST.includes('TO amirbtc_worker;'));
});

// ─── Idempotency / deploy-safety invariants ───

test('F02-SRC-010: statements are idempotent-safe (REVOKE and conditional GRANT; single COMMIT preserved)', () => {
  // REVOKE is naturally idempotent; the GRANT is guarded by IF EXISTS so a
  // re-run does not fail; the file keeps exactly one COMMIT (transaction wrapper).
  const commits = MIGRATE.split('\n').filter(l => l.trim() === 'COMMIT;').length;
  assert.strictEqual(commits, 1, 'exactly one COMMIT (single transaction wrapper)');
});

test('F02-SRC-011: migration must not contain forbidden destructive DDL (CI static-check contract)', () => {
  const active = MIGRATE.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bDROP TABLE\b/.test(active), 'no DROP TABLE');
  assert.ok(!/\bDROP COLUMN\b/.test(active), 'no DROP COLUMN');
  assert.ok(!/\bTRUNCATE\b/.test(active), 'no TRUNCATE');
  assert.ok(!/\bDROP SCHEMA\b/.test(active), 'no DROP SCHEMA');
});

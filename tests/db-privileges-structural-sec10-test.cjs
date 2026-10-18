/**
 * DB PRIVILEGES STRUCTURAL REGRESSION TEST — SEC-10 (Phase 20)
 * =============================================================
 *
 * FINDING (Phase 19 final audit, re-verified in Phase 20 scope at 698b3c71):
 *   * No RLS / CREATE POLICY exists anywhere in the SQL migration chain —
 *     acknowledged, deliberate architecture: the Worker connects with a
 *     SINGLE role (amirbtc_worker — verified live during F-02: 5 active
 *     connections) and row ownership is enforced at the APPLICATION layer
 *     (per-query WHERE telegram_id = $1 predicates). Per-user RLS would
 *     require SET LOCAL session-variable plumbing through the whole
 *     queryDb chain — an owner/DBA-coordinated project, NOT a code fix.
 *   * scripts/01-revoke-anon-authenticated.sql (defense-in-depth revocation
 *     of the Supabase PostgREST roles anon/authenticated) is NOT wired into
 *     any CI workflow — its live-application status is owner-manual.
 *
 * WHAT THIS TEST LOCKS (in scope for Phase 20 — zero .sql file changes,
 * zero live-DB execution):
 *   1. 00-migrate.sql (the ONLY migration CI runs) never GRANTs to
 *      anon/authenticated — the Supabase PostgREST surface cannot silently
 *      re-open via a deploy.
 *   2. The F-02 function-privilege posture stays intact (REVOKE FROM PUBLIC
 *      + role-existence-guarded GRANT to amirbtc_worker). This overlaps
 *      tests/db-function-permissions-f02-test.cjs by design: that file
 *      locks the fix's history, this file locks the SEC-10 posture.
 *   3. 01-revoke-anon-authenticated.sql keeps its schema-wide REVOKE
 *      statements and stays a BEGIN/COMMIT transaction — i.e. it remains
 *      the versioned, repeatable, reviewable MANUAL migration the owner
 *      can apply.
 *   4. NO workflow auto-runs 01-revoke (owner-manual by design — per
 *      Phase 20 instruction, automatic execution on the live DB must NOT
 *      be enabled).
 *   5. NEITHER migration file enables RLS or creates policies — a
 *      documentation-as-test lock: any future RLS work is an explicit,
 *      reviewed change that must update this file's expectations
 *      deliberately (and requires owner/DBA approval per the Phase 20
 *      scope decision).
 *
 * EXPLICIT NON-CLAIMS (documented, not hidden):
 *   * This test does NOT prove the live DB's current privilege state
 *     (no live queries are possible from here) — the verification queries
 *     live at the bottom of 01-revoke-anon-authenticated.sql.
 *   * This test does NOT claim RLS exists or is needed on specific tables.
 *   * The Worker's role/BYPASSRLS/ownership status on the live schema is
 *     unknown from repository evidence and is flagged for owner/DBA.
 *
 * Run: node --test tests/db-privileges-structural-sec10-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MIGRATE = fs.readFileSync(path.join(REPO, 'scripts', '00-migrate.sql'), 'utf8');
const REVOKE = fs.readFileSync(path.join(REPO, 'scripts', '01-revoke-anon-authenticated.sql'), 'utf8');
const PROD_WF = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-production.yml'), 'utf8');
const STG_WF = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-staging.yml'), 'utf8');
const DEPLOY_DOC = fs.readFileSync(path.join(REPO, 'docs', 'DEPLOY_SECURITY.md'), 'utf8');

/** Executable (non-comment) lines of a SQL file. */
function sqlCodeLines(src) {
  const out = [];
  for (const raw of src.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('--')) continue;
    out.push(l);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — 00-migrate.sql (the CI-wired migration) privilege posture
// ═══════════════════════════════════════════════════════════════════════════

test('SEC10-M1: 00-migrate.sql never GRANTs table privileges to anon or authenticated', () => {
  const grants = sqlCodeLines(MIGRATE).filter(l => /\bGRANT\b/i.test(l));
  assert.ok(grants.length > 0, '00-migrate.sql must still contain its (function) grants');
  for (const g of grants) {
    assert.ok(!/\bTO\s+(anon|authenticated)\b/i.test(g),
      `table/DML grants to PostgREST roles must not appear: ${g.slice(0, 90)}`);
  }
});

test('SEC10-M2: 00-migrate.sql keeps the F-02 posture — REVOKE EXECUTE FROM PUBLIC on groq_generate_with_key + guarded grant to amirbtc_worker', () => {
  assert.ok(
    MIGRATE.includes('REVOKE EXECUTE ON FUNCTION public.groq_generate_with_key(text, jsonb, text, integer, double precision) FROM PUBLIC;'),
    'the F-02 REVOKE must remain in the CI-wired migration');
  assert.ok(
    MIGRATE.includes("SELECT 1 FROM pg_roles WHERE rolname = 'amirbtc_worker'"),
    'the amirbtc_worker grant must stay guarded by the pg_roles existence check');
  assert.ok(
    /GRANT EXECUTE ON FUNCTION public\.groq_generate_with_key\([^)]*\) TO amirbtc_worker;/.test(MIGRATE),
    'the guarded GRANT to amirbtc_worker must remain');
});

test('SEC10-M3: 00-migrate.sql contains NO RLS enablement and NO policies (architecture lock — deliberate)', () => {
  for (const l of sqlCodeLines(MIGRATE)) {
    assert.ok(!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(l),
      `RLS enablement is an owner/DBA decision, not a CI-applied default: ${l.slice(0, 80)}`);
    assert.ok(!/CREATE\s+POLICY/i.test(l),
      `policies are an owner/DBA decision, not a CI-applied default: ${l.slice(0, 80)}`);
    assert.ok(!/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(l) && !/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(l),
      `RLS flags must not be touched by the CI migration: ${l.slice(0, 80)}`);
  }
});

test('SEC10-M4: 00-migrate.sql keeps its destructive-DDL-free character (DROP/TRUNCATE only in comments or the allowed legacy constraint drop)', () => {
  const drops = sqlCodeLines(MIGRATE).filter(l => /\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b|TRUNCATE/i.test(l));
  assert.equal(drops.length, 0, 'the CI migration must stay free of destructive DDL');
  const dropConstraints = sqlCodeLines(MIGRATE).filter(l => /\bDROP\s+CONSTRAINT\b/i.test(l));
  assert.ok(dropConstraints.length <= 1, 'at most the single allowed legacy wheel_spins DROP CONSTRAINT');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — 01-revoke-anon-authenticated.sql (the manual migration)
// ═════════════════════════════════════════════════════════════ documented ═
// (kept as a separate versioned, repeatable, reviewable file)

test('SEC10-R1: 01-revoke revokes ALL table privileges from BOTH PostgREST roles, schema-wide', () => {
  assert.ok(REVOKE.includes('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;'),
    'the schema-wide REVOKE from anon must remain');
  assert.ok(REVOKE.includes('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;'),
    'the schema-wide REVOKE from authenticated must remain');
});

test('SEC10-R2: 01-revoke is transaction-wrapped (BEGIN/COMMIT) — atomic and repeatable', () => {
  const code = sqlCodeLines(REVOKE);
  assert.equal(code[0], 'BEGIN;', 'the file must open its transaction');
  assert.ok(code.includes('COMMIT;'), 'the file must commit its transaction');
});

test('SEC10-R3: 01-revoke revokes EXECUTE FROM PUBLIC on both Groq gateway functions', () => {
  assert.ok(REVOKE.includes('REVOKE EXECUTE ON FUNCTION public.groq_generate(text, jsonb, integer, double precision) FROM PUBLIC;'));
  assert.ok(REVOKE.includes('REVOKE EXECUTE ON FUNCTION public.groq_generate_with_key(text, jsonb, text, integer, double precision) FROM PUBLIC;'));
});

test('SEC10-R4: 01-revoke does NOT enable RLS or create policies (matches its own documented contract)', () => {
  for (const l of sqlCodeLines(REVOKE)) {
    assert.ok(!/ENABLE\s+ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY/i.test(l),
      `01-revoke must stay privilege-only: ${l.slice(0, 80)}`);
  }
  // The file itself documents this contract — keep it honest.
  assert.ok(REVOKE.includes('Does NOT enable RLS, create policies'),
    'the documented no-RLS contract statement must remain in the file');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Pipeline wiring: what CI may and may NOT run
// ═══════════════════════════════════════════════════════════════════════════

test('SEC10-P1: NO workflow auto-runs 01-revoke-anon-authenticated.sql (owner-manual by design)', () => {
  assert.ok(!PROD_WF.includes('01-revoke-anon-authenticated.sql'),
    'the production workflow must NOT wire the manual revocation migration');
  assert.ok(!STG_WF.includes('01-revoke-anon-authenticated.sql'),
    'the staging workflow must NOT wire the manual revocation migration');
});

test('SEC10-P2: the only .sql file any workflow runs is scripts/00-migrate.sql', () => {
  const prodSqlRefs = [...PROD_WF.matchAll(/scripts\/[0-9A-Za-z._-]+\.sql/g)].map(m => m[0]);
  assert.deepEqual(prodSqlRefs.filter((v, i, a) => a.indexOf(v) === i), ['scripts/00-migrate.sql'],
    'the production migrate job must run exactly 00-migrate.sql');
  assert.equal([...STG_WF.matchAll(/\.sql/g)].length, 0, 'staging must run no SQL files');
});

test('SEC10-P3: the production migration job keeps its destructive-DDL static guards + idempotency re-run', () => {
  assert.ok(PROD_WF.includes('FORBIDDEN destructive DDL detected'), 'the static DDL guard step must remain');
  assert.ok(PROD_WF.includes('Idempotency test passed'), 'the idempotency re-run step must remain');
  assert.ok(PROD_WF.includes('ON_ERROR_STOP=1'), 'atomic error-stop psql flags must remain');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Documentation truth (DB security model + runbook)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC10-D1: DEPLOY_SECURITY.md documents the real single-role access model', () => {
  assert.ok(DEPLOY_DOC.includes('amirbtc_worker'), 'the Worker role must be documented');
  assert.ok(DEPLOY_DOC.includes('لایه اپلیکیشن') || DEPLOY_DOC.includes('application layer'),
    'app-layer ownership enforcement must be documented');
});

test('SEC10-D2: DEPLOY_SECURITY.md carries the manual 01-revoke runbook and the RLS owner/DBA gate', () => {
  assert.ok(DEPLOY_DOC.includes('01-revoke-anon-authenticated.sql'), 'the manual migration must be referenced');
  assert.ok(DEPLOY_DOC.includes('Runbook') || DEPLOY_DOC.includes('runbook'), 'a runbook section must exist');
  assert.ok(DEPLOY_DOC.includes('RLS'), 'the RLS owner/DBA decision must be documented');
  assert.ok(DEPLOY_DOC.includes('اجرا نشده') || DEPLOY_DOC.includes('فعال نشده'),
    'the doc must state that 01-revoke auto-execution is deliberately NOT enabled');
});

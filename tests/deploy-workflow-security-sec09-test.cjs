/**
 * DEPLOY WORKFLOW SECURITY REGRESSION TEST — SEC-09 (Phase 20)
 * =============================================================
 *
 * FINDING (Phase 19 final audit, re-verified in Phase 20 scope at 698b3c71):
 *   * .github/workflows/deploy-production.yml and deploy-staging.yml had NO
 *     `permissions:` block — the workflow GITHUB_TOKEN inherited the repo/org
 *     default (potentially read/write) although nothing in either workflow
 *     needs any write scope (deploys authenticate with CLOUDFLARE_* secrets).
 *   * deploy-production.yml exposed a `skip_tests` workflow_dispatch input
 *     that allowed deploying PRODUCTION with the test job fully skipped.
 *     Usage audit (read-only GitHub API, Phase 20): 0 of 651 production runs
 *     ever used workflow_dispatch — dead hatch, evidence-based removal.
 *   * docs/DEPLOY_SECURITY.md documented a world that no longer existed
 *     ("production is manual-only / Actions deploys staging only / no
 *     production reference in workflow YAML") — all three claims false.
 *
 * FIX UNDER TEST:
 *   * `permissions: contents: read` at workflow level in BOTH files.
 *   * skip_tests input removed; all job gates are strict needs-chains
 *     (push-event semantics proven identical: skip_tests is empty on push,
 *     so the old conditions always reduced to needs.*.result == 'success').
 *   * DEPLOY_SECURITY.md rewritten to match reality + a manual owner
 *     hardening runbook (branch protection, environment protection, token
 *     default-permissions) — explicitly NOT claimed to be already protected.
 *
 * NOTE ON YAML VALIDATION: no YAML parser exists in the dependency tree, so
 * this file uses structural text assertions (same precedent as
 * tests/db-function-permissions-f02-test.cjs for SQL) plus a basic YAML
 * sanity check (tabs/indentation/top-level shape). The final gate for YAML
 * validity is GitHub's own parser on the next push to main — which is why
 * the assertions here are deliberately conservative about the exact shape
 * of everything that surrounds the security properties being locked.
 *
 * Run: node --test tests/deploy-workflow-security-sec09-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PROD = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-production.yml'), 'utf8');
const STG = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-staging.yml'), 'utf8');
const DEPLOY_DOC = fs.readFileSync(path.join(REPO, 'docs', 'DEPLOY_SECURITY.md'), 'utf8');

/** Strip full-line comments and blank lines. */
function codeLines(src) {
  return src.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('#'));
}

/** Basic YAML sanity: no tabs, even 2-space indentation, known top-level keys. */
function assertBasicYamlSanity(src, label) {
  assert.ok(!src.includes('\t'), `${label}: workflow YAML must not contain tab characters`);
  const KNOWN_TOP = new Set(['name:', 'on:', 'permissions:', 'concurrency:', 'jobs:', 'env:', 'run-name:']);
  for (const l of codeLines(src)) {
    const indent = l.length - l.trimStart().length;
    assert.equal(indent % 2, 0, `${label}: odd indentation (not 2-space steps): ${JSON.stringify(l)}`);
    if (indent === 0) {
      const key = l.split(':')[0] + ':';
      assert.ok(KNOWN_TOP.has(key), `${label}: unexpected top-level key "${key}"`);
    }
  }
}

/** Extract one job's block (comments stripped): from `  <jobName>:` to the next job key at the same indent. */
function jobBlock(src, jobName) {
  const lines = src.split('\n');
  const startIdx = lines.findIndex(l => l === `  ${jobName}:`);
  assert.ok(startIdx > -1, `job ${jobName} must exist`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).filter(l => !l.trim().startsWith('#')).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Least-privilege GITHUB_TOKEN (both workflows)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-Y1: deploy-production.yml has a workflow-level permissions block limited to contents: read', () => {
  const lines = codeLines(PROD);
  const permIdx = lines.findIndex(l => l === 'permissions:');
  assert.ok(permIdx > -1, 'top-level `permissions:` must exist');
  assert.equal(lines[permIdx + 1], '  contents: read', 'the only permission must be contents: read');
});

test('SEC09-Y2: deploy-staging.yml has a workflow-level permissions block limited to contents: read', () => {
  const lines = codeLines(STG);
  const permIdx = lines.findIndex(l => l === 'permissions:');
  assert.ok(permIdx > -1, 'top-level `permissions:` must exist');
  assert.equal(lines[permIdx + 1], '  contents: read', 'the only permission must be contents: read');
});

test('SEC09-Y3: no write-capable permission scopes were introduced in either workflow', () => {
  for (const [src, label] of [[PROD, 'production'], [STG, 'staging']]) {
    for (const l of codeLines(src)) {
      assert.ok(!/^\s*(contents|packages|deployments|id-token|pages|actions|checks|discussions|pull-requests|security-events|statuses|attestations):\s*(write|none)/.test(l) || /read/.test(l),
        `${label}: unexpected permission line ${JSON.stringify(l)}`);
      assert.ok(!/write/.test(l) || !/^\s*[a-z-]+:\s*write/.test(l),
        `${label}: write permission must not appear: ${JSON.stringify(l)}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — skip_tests hatch removed, strict test gating
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-Y4: no skip_tests input or reference remains in either workflow (outside explanatory comments)', () => {
  for (const [src, label] of [[PROD, 'production'], [STG, 'staging']]) {
    for (const l of codeLines(src)) {
      assert.ok(!l.includes('skip_tests') || l.trim().startsWith('#'),
        `${label}: skip_tests must not appear in executable YAML lines: ${JSON.stringify(l)}`);
    }
  }
});

test('SEC09-Y5: the production test job is unconditional (no if:) and runs npm test', () => {
  const job = jobBlock(PROD, 'test');
  assert.ok(!/^    if:/m.test(job), 'the test job must not carry an if: gate');
  assert.ok(job.includes('run: npm test'), 'the test job must run npm test');
});

test('SEC09-Y6: migrate-db / deploy-worker / deploy-pages have no if: bypass (strict needs-chain)', () => {
  for (const jobName of ['migrate-db', 'deploy-worker', 'deploy-pages']) {
    const job = jobBlock(PROD, jobName);
    assert.ok(!/^    if:/m.test(job), `job ${jobName} must not carry an if: bypass arm`);
  }
});

test('SEC09-Y7: needs-chain is strict (test -> migrate-db -> deploys -> verify)', () => {
  assert.ok(!/needs:/.test(jobBlock(PROD, 'test')), 'test job must have no needs (comments excluded)', );
  assert.ok(jobBlock(PROD, 'migrate-db').includes('needs: test'), 'migrate-db must need test');
  assert.ok(jobBlock(PROD, 'deploy-worker').includes('needs: [test, migrate-db]'), 'deploy-worker must need test+migrate-db');
  assert.ok(jobBlock(PROD, 'deploy-pages').includes('needs: [test, migrate-db]'), 'deploy-pages must need test+migrate-db');
  assert.ok(jobBlock(PROD, 'verify').includes('needs: [deploy-worker, deploy-pages]'), 'verify must need both deploys');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Triggers, pinning, deploy surface unchanged
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-Y8: production triggers are push to main only + bare workflow_dispatch (no inputs)', () => {
  const onBlock = PROD.split('jobs:')[0];
  assert.ok(/push:/.test(onBlock), 'push trigger must exist');
  assert.ok(/branches:\s*main\s*$/m.test(onBlock) || /branches:\s*\n\s*- main\s*$/m.test(onBlock),
    'push trigger must target main only (flow or block style)');
  assert.ok(!/branches:\s*\*/.test(onBlock) && !/branches:\s*\[/.test(onBlock),
    'push trigger must not use wildcards or multi-branch lists');
  const dispatchMatch = onBlock.match(/workflow_dispatch:\s*(\n\s+\S.*)?/);
  assert.ok(dispatchMatch, 'workflow_dispatch must exist (manual dispatch preserved)');
  assert.ok(!dispatchMatch[1], 'workflow_dispatch must have NO inputs (skip_tests removed)');
});

test('SEC09-Y9: staging trigger is push to main only (no manual dispatch)', () => {
  const onBlock = STG.split('jobs:')[0];
  assert.ok(/push:/.test(onBlock), 'push trigger must exist');
  assert.ok(/branches:\s*main\s*$/m.test(onBlock) || /branches:\s*\n\s*- main\s*$/m.test(onBlock),
    'push trigger must target main only (flow or block style)');
  assert.ok(!/workflow_dispatch/.test(onBlock), 'staging must not add manual dispatch');
});

test('SEC09-Y10: every `uses:` action is pinned to a full commit SHA', () => {
  for (const [src, label] of [[PROD, 'production'], [STG, 'staging']]) {
    const uses = codeLines(src).filter(l => l.trim().startsWith('- uses:'));
    assert.ok(uses.length > 0, `${label}: expected pinned actions`);
    for (const l of uses) {
      const ref = l.split('@')[1]?.trim().split(' ')[0];
      assert.ok(/^[0-9a-f]{40}$/.test(ref || ''), `${label}: action not pinned to a 40-hex SHA: ${JSON.stringify(l)}`);
    }
  }
});

test('SEC09-Y11: deploy commands and concurrency groups unchanged', () => {
  assert.ok(PROD.includes('npx wrangler deploy --env production'), 'worker deploy command must be unchanged');
  assert.ok(PROD.includes('--project-name amir-btc-assistant-pages --branch=main'), 'pages deploy command must be unchanged');
  assert.ok(STG.includes('npx wrangler deploy --env staging'), 'staging deploy command must be unchanged');
  assert.ok(/group: deploy-production/.test(PROD) && /group: deploy-staging/.test(STG), 'concurrency groups must be preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Migration job surface (cross-lock with SEC-10)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-Y12: the migrate job runs ONLY scripts/00-migrate.sql — 01-revoke is never auto-run', () => {
  const job = jobBlock(PROD, 'migrate-db');
  const sqlRefs = [...job.matchAll(/scripts\/[0-9A-Za-z._-]+\.sql/g)].map(m => m[0]);
  assert.ok(sqlRefs.length > 0 && sqlRefs.every(r => r === 'scripts/00-migrate.sql'),
    `only 00-migrate.sql may be referenced, found: ${JSON.stringify(sqlRefs)}`);
  assert.ok(!PROD.includes('01-revoke-anon-authenticated.sql'),
    '01-revoke-anon-authenticated.sql must NOT be wired into CI (owner-manual by design)');
  assert.ok(!STG.includes('.sql'), 'staging workflow must not run any SQL file');
});

test('SEC09-Y13: SUPABASE_DATABASE_URL is never echoed to logs', () => {
  for (const l of codeLines(PROD)) {
    assert.ok(!/echo.*\$SUPABASE_DATABASE_URL/.test(l),
      `the URL value must not be printed: ${JSON.stringify(l.slice(0, 80))}`);
  }
  assert.ok(PROD.includes('unset SUPABASE_DATABASE_URL'), 'the exposure-minimizing unset must remain');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — DEPLOY_SECURITY.md matches reality
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-D1: the doc no longer claims production is manual-only / Actions deploys staging only', () => {
  const contradictions = [
    'هیچ سیستم خودکاری حق deploy به production ندارد',
    'production:** در این workflow وجود ندارد و هرگز deploy نمی‌شود',
    'هیچ reference‌ای به production ندارد',
  ];
  for (const c of contradictions) {
    assert.ok(!DEPLOY_DOC.includes(c), `the doc must not repeat the outdated claim: "${c}"`);
  }
});

test('SEC09-D2: the doc documents the real production pipeline + the SEC-09 changes', () => {
  assert.ok(DEPLOY_DOC.includes('deploy-production.yml'), 'must reference deploy-production.yml');
  assert.ok(DEPLOY_DOC.includes('workflow_dispatch'), 'must document the manual dispatch path');
  assert.ok(DEPLOY_DOC.includes('contents: read'), 'must document the permissions restriction');
  assert.ok(DEPLOY_DOC.includes('skip_tests'), 'must document the skip_tests removal');
  assert.ok(DEPLOY_DOC.includes('migrate-db'), 'must document the production migration job');
  assert.ok(DEPLOY_DOC.includes('SUPABASE_DATABASE_URL'), 'must document the DB secret');
});

test('SEC09-D3: the doc explicitly reports owner-manual protections as NOT yet enabled (no false safety)', () => {
  assert.ok(DEPLOY_DOC.includes('فعال نیست') || DEPLOY_DOC.includes('فعلاً خاموش'),
    'branch/environment protection must be explicitly reported as not yet enabled');
  assert.ok(DEPLOY_DOC.includes('Environment'), 'environment protection guidance must be present');
  assert.ok(!/GitHub Environment از قبل محافظت‌شده/.test(DEPLOY_DOC),
    'the doc must NOT claim the GitHub Environment is already protected');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Basic YAML sanity (no parser in the dependency tree — see note)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC09-Y0: both workflows pass basic YAML shape sanity (tabs/indentation/top-level keys)', () => {
  assertBasicYamlSanity(PROD, 'production');
  assertBasicYamlSanity(STG, 'staging');
});

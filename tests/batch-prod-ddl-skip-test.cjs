/**
 * Batch Production DDL Skip Test
 *
 * Verifies that all 11 repositories have a production early-return guard
 * that skips runtime DDL (CREATE TABLE / ALTER TABLE / CREATE INDEX)
 * when env.APP_ENV === 'production'.
 *
 * Run: node --test tests/batch-prod-ddl-skip-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const REPOS = [
  { file: 'src/repositories/wallet.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/referrals.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/reward_center.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/wheel.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/advertisements.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/admin.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/calendar_reminders.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/analyses.js', flag: '_schemaVerified', func: 'ensureSchema', pattern: 'return' },
  { file: 'src/repositories/notifications.js', flag: '_tableEnsured', func: 'ensureTable', pattern: 'return' },
  { file: 'src/repositories/app_content.js', flag: '_tableEnsured', func: 'ensureTable', pattern: 'return' },
  { file: 'src/repositories/membership.js', flag: '_welcomeColumnEnsured', func: 'inline ALTER', pattern: 'if-else' },
];

for (const repo of REPOS) {
  const srcPath = path.join(ROOT, repo.file);
  const shortName = path.basename(repo.file);

  test(`DDL-SKIP [${shortName}]: has PROD-DDL-SKIP guard`, () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.ok(src.includes('PROD-DDL-SKIP'),
      `${shortName} must have PROD-DDL-SKIP guard`);
  });

  test(`DDL-SKIP [${shortName}]: guard checks env.APP_ENV === production`, () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.ok(src.includes("APP_ENV") && src.includes("'production'"),
      `${shortName} must check env.APP_ENV === 'production'`);
  });

  test(`DDL-SKIP [${shortName}]: guard sets flag`, () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const guardIdx = src.indexOf('PROD-DDL-SKIP');
    const afterGuard = src.slice(guardIdx, guardIdx + 300);
    assert.ok(afterGuard.includes(`${repo.flag} = true`),
      `${shortName} guard must set ${repo.flag} = true`);
    if (repo.pattern === 'return') {
      assert.ok(afterGuard.includes('return'),
        `${shortName} guard must return after setting flag`);
    }
  });

  test(`DDL-SKIP [${shortName}]: DDL still present for non-production`, () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const hasDDL = src.includes('CREATE TABLE') || src.includes('ALTER TABLE') || src.includes('CREATE INDEX');
    assert.ok(hasDDL,
      `${shortName} must still contain DDL for non-production environments`);
  });

  test(`DDL-SKIP [${shortName}]: guard comes AFTER existing flag check`, () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const guardIdx = src.indexOf('PROD-DDL-SKIP');
    if (repo.pattern === 'if-else') {
      // membership.js uses if (!flag) { if (production) { ... } else { DDL } }
      const negFlagIdx = src.indexOf(`if (!${repo.flag})`);
      assert.ok(negFlagIdx > -1 && negFlagIdx < guardIdx,
        `${shortName}: if (!${repo.flag}) must come before PROD-DDL-SKIP`);
    } else {
      const flagCheckIdx = src.indexOf(`if (${repo.flag}) return`);
      assert.ok(flagCheckIdx > -1,
        `${shortName} must have if (${repo.flag}) return check`);
      assert.ok(flagCheckIdx < guardIdx,
        `${shortName}: if (${repo.flag}) return must come before PROD-DDL-SKIP`);
    }
  });
}

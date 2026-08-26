/**
 * _schemaVerified Bug Fix Regression Tests
 * =========================================
 *
 * Verifies that ALL ensureSchema/ensureTable functions across ALL repositories
 * do NOT set _schemaVerified = true on error. Only set it on success.
 *
 * Run: node --test schema-verified-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_FILES = [
  'src/repositories/admin.js',
  'src/repositories/referrals.js',
  'src/repositories/calendar_reminders.js',
  'src/repositories/alert_economy.js',
  'src/repositories/wheel.js',
  'src/repositories/reward_center.js',
];

// ============================================================================
// Test each repository file
// ============================================================================

for (const file of REPO_FILES) {
  const fullPath = path.join(__dirname, file);
  if (!fs.existsSync(fullPath)) continue;
  const SRC = fs.readFileSync(fullPath, 'utf8');
  const baseName = path.basename(file, '.js');

  test(`${baseName}: _schemaVerified NOT set on error (return in catch)`, () => {
    // Find all catch blocks that contain _schemaVerified
    const catchBlocks = SRC.match(/catch\s*\([^)]*\)\s*\{[^}]*_schemaVerified[^}]*\}/g) || [];
    for (const block of catchBlocks) {
      // If the catch block sets _schemaVerified = true, it must also have return
      if (block.includes('_schemaVerified = true')) {
        assert.match(block, /return/,
          `${baseName}: catch block sets _schemaVerified = true but does NOT return — ` +
          `this means _schemaVerified is set on error, permanently blocking schema retry`);
      }
    }
  });

  test(`${baseName}: _schemaVerified = true only AFTER try block (not inside catch)`, () => {
    // The pattern should be: try { ... _schemaVerified = true; } catch { return; }
    // NOT: try { ... } catch { _schemaVerified = true; }
    const lines = SRC.split('\n');
    let inCatch = false;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('catch')) { inCatch = true; braceDepth = 0; }
      if (inCatch) {
        if (line.includes('{')) braceDepth++;
        if (line.includes('}')) braceDepth--;
        if (braceDepth <= 0 && i > 0) inCatch = false;
        if (line.includes('_schemaVerified = true')) {
          assert.fail(
            `${baseName} line ${i+1}: _schemaVerified = true found inside catch block — ` +
            `must be moved to after the try block (only set on success)`);
        }
      }
    }
  });
}

// ============================================================================
// Verify the fix pattern: return in catch before _schemaVerified = true
// ============================================================================

test('ALL repos: every catch block with _schemaVerified has return', () => {
  for (const file of REPO_FILES) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) continue;
    const SRC = fs.readFileSync(fullPath, 'utf8');
    // Find all occurrences of _schemaVerified in catch context
    const matches = SRC.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g) || [];
    for (const block of matches) {
      if (block.includes('_schemaVerified')) {
        assert.ok(block.includes('return'),
          `${file}: catch block referencing _schemaVerified must contain 'return'`);
      }
    }
  }
});

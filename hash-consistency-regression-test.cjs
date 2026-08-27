/**
 * Hash Consistency Regression Test
 * =================================
 *
 * Verifies that scripts/prepare-pages.mjs computes content hashes AFTER all
 * content modifications (minify + asset-reference replacement), so the hash
 * in every built filename matches the actual file content.
 *
 * Triggered by the "Hash mismatch" issue: previously, asset references were
 * replaced AFTER files were already written under their hashed names, so 3
 * files (app.js, referral.js, wallet.js) had hashes that didn't match their
 * content — breaking cache-busting guarantees.
 *
 * Run: node --test hash-consistency-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.join(__dirname);
const distDir = path.join(projectRoot, 'webapp', 'pages-dist');

// ============================================================================
// Static checks on prepare-pages.mjs source
// ============================================================================

const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'prepare-pages.mjs'), 'utf8');

test('SRC-1: copyWithHash accepts assetRenameMap parameter', () => {
  assert.match(buildSrc, /async function copyWithHash\(assetRenameMap\)/,
    'copyWithHash must accept assetRenameMap so it can replace asset references before hashing');
});

test('SRC-2: asset references are replaced BEFORE hash computation', () => {
  const fnStart = buildSrc.indexOf('async function copyWithHash(assetRenameMap)');
  assert.ok(fnStart > -1, 'copyWithHash function not found');
  const fnBody = buildSrc.slice(fnStart, fnStart + 2000);
  const assetReplaceIdx = fnBody.indexOf('for (const [original, hashed] of assetRenameMap)');
  const hashIdx = fnBody.indexOf('createHash(\'sha256\')');
  assert.ok(assetReplaceIdx > -1, 'copyWithHash must contain the asset-reference replacement loop');
  assert.ok(hashIdx > -1, 'copyWithHash must compute the content hash');
  assert.ok(assetReplaceIdx < hashIdx,
    'asset references must be replaced BEFORE the hash is computed (was after — caused mismatch)');
});

test('SRC-3: main() processes assets BEFORE JS/CSS', () => {
  const mainStart = buildSrc.indexOf('async function main()');
  assert.ok(mainStart > -1, 'main function not found');
  const mainBody = buildSrc.slice(mainStart, mainStart + 3000);
  // Filter to code lines only (strip comments) to avoid false matches
  const codeLines = mainBody.split('\n').filter(l => !l.trim().startsWith('//'));
  const codeBody = codeLines.join('\n');
  const assetsIdx = codeBody.indexOf('copyAssetsWithHash()');
  const jsIdx = codeBody.indexOf('copyWithHash(');
  assert.ok(assetsIdx > -1, 'main must call copyAssetsWithHash()');
  assert.ok(jsIdx > -1, 'main must call copyWithHash()');
  assert.ok(assetsIdx < jsIdx,
    'main must process assets BEFORE JS/CSS so the assetRenameMap is available during hashing');
});

test('SRC-4: old post-write asset replacement loop is removed', () => {
  // The old loop read files AFTER they were written under hashed names and
  // replaced asset references in them — causing the hash mismatch. It must
  // be gone.
  assert.ok(!/Replace asset references in built JS files/.test(buildSrc),
    'the old "Replace asset references in built JS files" loop must be removed — it caused the hash mismatch');
});

// ============================================================================
// Dynamic checks: run the build and verify every file's hash matches
// ============================================================================

test('BUILD-1: build produces output directory', () => {
  // Run the build
  try {
    execSync('node scripts/prepare-pages.mjs', { cwd: projectRoot, stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    assert.fail(`Build failed: ${e.message}`);
  }
  assert.ok(fs.existsSync(distDir), 'webapp/pages-dist must exist after build');
});

test('BUILD-2: every built JS/CSS file hash matches its content', () => {
  const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js') || f.endsWith('.css'));
  assert.ok(files.length >= 12, `Expected at least 12 JS/CSS files, found ${files.length}`);

  const mismatches = [];
  for (const f of files) {
    const filePath = path.join(distDir, f);
    const data = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
    const match = f.match(/^[a-z-]+\.([a-f0-9]{8})\.(js|css)$/);
    if (!match) {
      // File without hash in name — skip (e.g., version.json is not hashed)
      continue;
    }
    const expectedHash = match[1];
    if (actualHash !== expectedHash) {
      mismatches.push({ file: f, expected: expectedHash, actual: actualHash });
    }
  }
  assert.equal(mismatches.length, 0,
    `Hash mismatch detected in ${mismatches.length} file(s):\n` +
    mismatches.map(m => `  ${m.file}: expected ${m.expected}, actual ${m.actual}`).join('\n'));
});

test('BUILD-3: specifically verify the 3 previously-broken files (app.js, referral.js, wallet.js)', () => {
  // These 3 files had asset references (assets/market/*.webp, assets/token-logo.png)
  // and were the ones that had hash mismatch before the fix.
  const files = fs.readdirSync(distDir);
  for (const base of ['app', 'referral', 'wallet']) {
    const matching = files.filter(f => f.startsWith(base + '.') && f.endsWith('.js'));
    assert.ok(matching.length === 1, `Expected exactly 1 ${base}.<hash>.js, found ${matching.length}`);
    const f = matching[0];
    const data = fs.readFileSync(path.join(distDir, f));
    const actualHash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
    const expectedHash = f.match(/\.([a-f0-9]{8})\.js$/)[1];
    assert.equal(actualHash, expectedHash,
      `${f}: hash mismatch (expected ${expectedHash}, actual ${actualHash}) — the asset-reference replacement may have been re-introduced after hashing`);
  }
});

test('BUILD-4: asset references ARE replaced in built JS (not left as original paths)', () => {
  // Verify the fix didn't accidentally skip asset replacement entirely.
  // The built app.js should contain hashed asset names (e.g. 'assets/aeabf93b.webp'),
  // NOT original paths (e.g. 'assets/market/bull.webp').
  const files = fs.readdirSync(distDir);
  const appFile = files.find(f => f.startsWith('app.') && f.endsWith('.js'));
  assert.ok(appFile, 'app.js not found in build output');
  const appContent = fs.readFileSync(path.join(distDir, appFile), 'utf8');
  // Check that at least one hashed asset reference exists
  assert.match(appContent, /assets\/[a-f0-9]{8}\.(webp|png)/,
    'app.js must contain at least one hashed asset reference (e.g. assets/aeabf93b.webp) — if missing, asset replacement was skipped entirely');
  // Check that NO original asset paths remain (they should all be replaced)
  assert.ok(!/assets\/market\/(bull|bear|neutral)\.webp/.test(appContent),
    'app.js must NOT contain original asset paths (assets/market/bull.webp etc.) — they should be replaced with hashed names');
});

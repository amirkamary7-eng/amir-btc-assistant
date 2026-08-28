import { mkdir, copyFile, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// TASK 3 (Asset Performance): esbuild is used to minify JS & CSS before hashing.
// It is already installed as a transitive dependency of wrangler — no new dep needed.
// esbuild.transform() runs in process-safe mode (no bundle, no identifier mangling
// of window.* properties), so all global function names referenced by inline HTML
// event handlers (onclick="toggleNotificationPanel()", etc.) remain callable.
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'webapp', 'pages-dist');

const hashedFiles = [
  'shared-utils.js',
  'app.js',
  'base.css',
  'components.css',
  'dashboard.css',
  'market.css',
  'news.css',
  'coin-detail.css',
  'tickets.css',
  'style.css',
  'assistant.js',
  'notifications.js',
  'wallet.js',
  'wallet.css',
  'referral.js',
  'referral.css',
  'admin.js',
  'membership-user.js',
  'membership-admin.js',
  'cosmetics.js',
];

// ============================================================================
// Build ID Generation
// ============================================================================
function generateBuildId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  let shortHash = 'dev';
  try {
    shortHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: projectRoot }).trim();
  } catch {
    // Not in a git repo or git not available — use a random hex
    shortHash = createHash('sha256').update(timestamp).digest('hex').slice(0, 7);
  }
  return `${timestamp}-${shortHash}`;
}

// ============================================================================
// Core Build Steps
// ============================================================================
async function ensureCleanOutput() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
}

/**
 * TASK 3 (Asset Performance): Minify a JS or CSS source file with esbuild.
 *
 * Uses esbuild.transform() (NOT build/bundle) — this means:
 *   - No module resolution, no bundling, no tree-shaking
 *   - No source architecture changes (globals, top-level functions, window
 *     assignments all preserved exactly)
 *
 * CRITICAL: For JS, we use minifyWhitespace + minifySyntax (NOT minify: true).
 * esbuild's full `minify: true` runs identifier mangling which collides multiple
 * top-level let/const vars to the same short name (e.g. "je"), causing
 * "Identifier 'je' has already been declared" SyntaxErrors. The
 * minifyIdentifiers: false flag is ignored when minify: true is set in esbuild
 * 0.28.x, so we use the granular flags. This preserves ALL variable/function
 * names verbatim while still stripping whitespace + comments + minifying syntax.
 *
 * This is safe for the app's pattern where inline HTML event handlers call
 * global functions by name (onclick="toggleNotificationPanel()") — function
 * names are never mangled, so globals remain directly callable.
 *
 * CSS uses full `minify: true` (no identifier collision risk in CSS).
 *
 * If minification fails for any reason, the original source is used as a
 * fallback (build never breaks due to minify errors).
 */
async function minifySource(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const src = await readFile(filePath, 'utf8');
  const beforeBytes = Buffer.byteLength(src);

  // Non-hashed files and tiny files (< 500 bytes) are not worth minifying.
  if (beforeBytes < 500) return src;

  try {
    const isCss = ext === '.css';
    // Use minifyWhitespace + minifySyntax (NOT minify: true) because esbuild's
    // full `minify: true` also runs identifier mangling, which collides multiple
    // top-level let/const vars to the same short name (e.g. "je") causing
    // "Identifier 'je' has already been declared" SyntaxErrors. The
    // minifyIdentifiers: false flag is ignored when minify: true is set in
    // esbuild 0.28.x, so we use the granular flags instead. This preserves ALL
    // variable/function names verbatim (so inline HTML onclick="funcName()"
    // handlers keep working) while still stripping whitespace + comments +
    // minifying syntax (e.g. if(false){} → removed, object literal shorthand).
    const opts = isCss
      ? { minify: true, loader: 'css', target: 'es2020', legalComments: 'none', sourcemap: false }
      : { minifyWhitespace: true, minifySyntax: true, format: 'esm', target: 'es2020', legalComments: 'none', sourcemap: false };
    const result = await esbuild.transform(src, opts);
    const afterBytes = Buffer.byteLength(result.code);
    const reduction = ((1 - afterBytes / beforeBytes) * 100).toFixed(1);
    console.log(`    minify: ${(beforeBytes / 1024).toFixed(1)} KB → ${(afterBytes / 1024).toFixed(1)} KB (-${reduction}%)`);
    return result.code;
  } catch (e) {
    // Fallback: use original source if esbuild fails. Build must not break.
    console.warn(`    ⚠️  minify failed for ${path.basename(filePath)}: ${e.message} — using original`);
    return src;
  }
}

async function copyWithHash(assetRenameMap) {
  const renameMap = new Map();
  for (const basename of hashedFiles) {
    const source = path.join(projectRoot, basename);
    // TASK 3: minify before hashing so the hash reflects the MINIFIED content
    // (this is critical — if we hashed the source then wrote minified content
    // under that hash, the hash would be wrong and cache-busting would break).
    let content = await minifySource(source);

    // HASH MISMATCH FIX: replace asset references (e.g. 'assets/market/bull.webp'
    // → 'assets/aeabf93b.webp') BEFORE computing the content hash. Previously
    // this replacement happened AFTER the file was already written under its
    // hashed name, so the file's content no longer matched the hash in its
    // filename — breaking cache-busting guarantees. Now the hash is computed
    // on the FINAL content (minified + asset-referenced), so the filename
    // always matches the file body.
    for (const [original, hashed] of assetRenameMap) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'g');
      if (pattern.test(content)) {
        content = content.replace(pattern, hashed);
      }
    }

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    const parsed = path.parse(basename);
    const hashedName = `${parsed.name}.${hash}${parsed.ext}`;
    const target = path.join(outputDir, hashedName);
    await writeFile(target, content, 'utf8');
    renameMap.set(basename, hashedName);
    console.log(`  ${basename} → ${hashedName}`);
  }
  return renameMap;
}

async function copyIndexHtml() {
  const source = path.join(projectRoot, 'index.html');
  const target = path.join(outputDir, 'index.html');
  await copyFile(source, target);
}

/**
 * Copy assets with hash. Returns Map of "assets/oldname" → "assets/hashedname"
 */
async function copyAssetsWithHash() {
  const sourceAssets = path.join(projectRoot, 'assets');
  const targetAssets = path.join(outputDir, 'assets');
  await mkdir(targetAssets, { recursive: true });

  const renameMap = new Map();

  async function processDir(srcDir, relPath) {
    const entries = await readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await processDir(srcPath, entryRelPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const data = await readFile(srcPath);
      const hashStr = createHash('sha256').update(data).digest('hex').slice(0, 8);
      const hashedName = `${hashStr}${path.extname(entry.name)}`;
      const dstPath = path.join(targetAssets, hashedName);
      await copyFile(srcPath, dstPath);
      renameMap.set(`assets/${entryRelPath}`, `assets/${hashedName}`);
      console.log(`  assets/${entryRelPath} → assets/${hashedName}`);
    }
  }

  await processDir(sourceAssets, '');
  return renameMap;
}

/**
 * Replace all hashed references in HTML content.
 * Handles both JS/CSS renameMap and assets renameMap.
 */
function replaceReferences(html, jsRenameMap, assetRenameMap) {
  let result = html;

  // Replace JS/CSS references
  for (const [original, hashed] of jsRenameMap) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(href=["'])${escaped}(["'])`, 'g'),
      `$1${hashed}$2`,
    );
    result = result.replace(
      new RegExp(`(src=["'])${escaped}(["'])`, 'g'),
      `$1${hashed}$2`,
    );
  }

  // Replace asset references
  for (const [original, hashed] of assetRenameMap) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(src=["'])${escaped}(["'])`, 'g'),
      `$1${hashed}$2`,
    );
  }

  return result;
}

async function injectApiBase(html) {
  const workerApiUrl = process.env.WORKER_API_URL?.trim();
  if (!workerApiUrl) {
    // No env var → preserve the hardcoded Worker URL already in index.html.
    // Do NOT replace with window.location.origin (that breaks all API calls).
    return html;
  }
  const apiBaseScript = `<script>window.API_BASE = "${workerApiUrl}";</script>`;
  return html.replace(
    /<script>window\.API_BASE = .*?<\/script>/,
    apiBaseScript,
  );
}

/**
 * Inject the BUILD_ID into the inline version-check script in index.html.
 * Replaces __BUILD_ID_PLACEHOLDER__ with the actual build ID.
 */
function injectBuildId(html, buildId) {
  return html.replace(/__BUILD_ID_PLACEHOLDER__/g, buildId);
}

/**
 * Generate version.json — a tiny file fetched by the client to detect new deploys.
 * This file gets aggressive no-cache headers so it's ALWAYS fresh.
 */
async function writeVersionJson(buildId) {
  const versionData = {
    buildId,
    build_id: buildId,
    timestamp: new Date().toISOString(),
    deployedAt: Date.now(),
  };
  const versionPath = path.join(outputDir, 'version.json');
  await writeFile(versionPath, JSON.stringify(versionData, null, 2), 'utf8');
  console.log(`  version.json written (buildId: ${buildId})`);
}

/**
 * Write Cloudflare Pages _headers file with precise cache rules.
 * 
 * Key rules:
 * - index.html: NEVER cache (ensures Telegram WebView always gets fresh HTML)
 * - version.json: NEVER cache (version check must always hit origin)
 * - Hashed JS/CSS: cache 1 year immutable (content hash guarantees uniqueness)
 * - Hashed assets: cache 1 year immutable
 * - Everything else: no cache (safety net)
 */
async function writeHeadersFile() {
  const headersContent = [
    '# Cloudflare Pages cache headers',
    '# See: https://developers.cloudflare.com/pages/platform/headers/',
    '',
    '# ============================================================',
    '# CRITICAL: index.html — NEVER cache',
    '# Telegram WebView, Android WebView, and iOS WKWebView all respect',
    '# these headers. This ensures users ALWAYS get the latest HTML.',
    '# ============================================================',
    '/index.html',
    '  Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate',
    '  Pragma: no-cache',
    '  Expires: 0',
    '  Surrogate-Control: no-store',
    '  X-Content-Type-Options: nosniff',
    '',
    '# ============================================================',
    '# version.json — NEVER cache (version check endpoint)',
    '# ============================================================',
    '/version.json',
    '  Cache-Control: no-store, no-cache, must-revalidate',
    '  Pragma: no-cache',
    '  Expires: 0',
    '  Access-Control-Allow-Origin: *',
    '',
    '# ============================================================',
    '# Hashed JS files: cache 1 year (immutable)',
    '# Filenames include content hash, so they never change.',
    '# ============================================================',
    '/*.js',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# ============================================================',
    '# Hashed CSS files: cache 1 year (immutable)',
    '# ============================================================',
    '/*.css',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# ============================================================',
    '# Hashed asset images: cache 1 year (immutable)',
    '# ============================================================',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# ============================================================',
    '# NOTE: No catch-all rule. Cloudflare Pages merges matching rules,',
    '# so a /* catch-all would poison immutable headers on hashed assets.',
    '# All file types are explicitly covered above.',
    '# ============================================================',
    '',
  ].join('\n');

  const headersPath = path.join(outputDir, '_headers');
  await writeFile(headersPath, headersContent, 'utf8');
  console.log('  _headers written');
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const buildId = generateBuildId();
  console.log(`Build ID: ${buildId}`);
  console.log('Preparing Pages build output...');

  await ensureCleanOutput();
  console.log('  Cleaned output directory');

  // HASH MISMATCH FIX: process assets FIRST so the assetRenameMap is available
  // when copyWithHash() runs. copyWithHash() now replaces asset references in
  // JS/CSS content BEFORE computing the content hash, so the hash always
  // matches the final file body.
  const assetRenameMap = await copyAssetsWithHash();
  console.log('  Copied & hashed assets');

  const jsRenameMap = await copyWithHash(assetRenameMap);
  console.log('  Copied & hashed JS/CSS files (with asset references resolved)');

  await copyIndexHtml();
  console.log('  Copied index.html');

  // Copy calendar-data.json (static calendar data — avoids provider rate limits)
  try {
    await copyFile(path.join(projectRoot, 'assets', 'calendar-data.json'), path.join(outputDir, 'calendar-data.json'));
    console.log('  Copied calendar-data.json');
  } catch {
    console.log('  calendar-data.json not found — skipping');
  }

  let indexHtml = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  indexHtml = replaceReferences(indexHtml, jsRenameMap, assetRenameMap);
  indexHtml = await injectApiBase(indexHtml);
  indexHtml = injectBuildId(indexHtml, buildId);

  // ROOT CAUSE FIX: Inject ADMIN_JS_URL so app.js can lazy-load admin.js
  // prepare-pages.mjs hashes filenames (admin.js → admin.744b8c4e.js)
  // app.js needs to know the hashed filename to load it dynamically.
  const adminHashed = jsRenameMap.get('admin.js');
  if (adminHashed) {
    const adminUrlScript = `<script>window.ADMIN_JS_URL = "${adminHashed}";</script>`;
    indexHtml = indexHtml.replace(
      /<\/head>/,
      `${adminUrlScript}\n<\/head>`,
    );
    console.log(`  Injected ADMIN_JS_URL: ${adminHashed}`);
  }

  await writeFile(path.join(outputDir, 'index.html'), indexHtml, 'utf8');
  console.log('  Updated references, API_BASE, and BUILD_ID in index.html');

  // HASH MISMATCH FIX: the old asset-reference replacement loop that ran HERE
  // (after files were already written under their hashed names) has been
  // removed. Asset references are now replaced INSIDE copyWithHash() BEFORE
  // the hash is computed, so the filename always matches the file content.

  await writeVersionJson(buildId);

  await writeHeadersFile();

  console.log(`\n✅ Pages build complete: ${outputDir}`);
  console.log(`   Build ID: ${buildId}`);
  console.log(`   Deploy with: npx wrangler pages deploy ${outputDir} --project-name amir-btc-assistant-pages`);
}

main().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});
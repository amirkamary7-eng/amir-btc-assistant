import { mkdir, cp, copyFile, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'webapp', 'pages-dist');

const hashedFiles = [
  'app.js',
  'style.css',
  'assistant.js',
  'notifications.js',
  'wallet.js',
  'wallet.css',
  'admin.js',
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

async function contentHash(filePath) {
  const data = await readFile(filePath);
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const parsed = path.parse(filePath);
  return `${parsed.name}.${hash}${parsed.ext}`;
}

async function copyWithHash() {
  const renameMap = new Map();
  for (const basename of hashedFiles) {
    const source = path.join(projectRoot, basename);
    const hashed = await contentHash(source);
    const target = path.join(outputDir, hashed);
    await copyFile(source, target);
    renameMap.set(basename, hashed);
    console.log(`  ${basename} → ${hashed}`);
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
  const entries = await readdir(sourceAssets, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const srcPath = path.join(sourceAssets, entry.name);
    const data = await readFile(srcPath);
    const hashStr = createHash('sha256').update(data).digest('hex').slice(0, 8);
    const hashedName = `${hashStr}${path.extname(entry.name)}`;
    const dstPath = path.join(targetAssets, hashedName);
    await copyFile(srcPath, dstPath);
    renameMap.set(`assets/${entry.name}`, `assets/${hashedName}`);
    console.log(`  assets/${entry.name} → assets/${hashedName}`);
  }
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
    '# Catch-all: no cache for anything else (safety net)',
    '# ============================================================',
    '/*',
    '  Cache-Control: no-store, no-cache, must-revalidate',
    '  Pragma: no-cache',
    '  Expires: 0',
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

  const jsRenameMap = await copyWithHash();
  console.log('  Copied & hashed JS/CSS files');

  await copyIndexHtml();
  console.log('  Copied index.html');

  const assetRenameMap = await copyAssetsWithHash();
  console.log('  Copied & hashed assets');

  let indexHtml = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  indexHtml = replaceReferences(indexHtml, jsRenameMap, assetRenameMap);
  indexHtml = await injectApiBase(indexHtml);
  indexHtml = injectBuildId(indexHtml, buildId);
  await writeFile(path.join(outputDir, 'index.html'), indexHtml, 'utf8');
  console.log('  Updated references, API_BASE, and BUILD_ID in index.html');

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
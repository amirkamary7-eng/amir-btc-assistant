import { mkdir, cp, copyFile, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  'watchlist.js',
];

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
  const apiBaseScript = workerApiUrl
    ? `<script>window.API_BASE = "${workerApiUrl}";</script>`
    : '<script>window.API_BASE = window.API_BASE || window.location.origin;</script>';

  return html.replace(
    /<script>window\.API_BASE = .*?<\/script>/,
    apiBaseScript,
  );
}

async function writeHeadersFile() {
  const headersContent = [
    '# Cloudflare Pages cache headers',
    '# See: https://developers.cloudflare.com/pages/platform/headers/',
    '',
    '# index.html: never cache — always serve fresh',
    '/index.html',
    '  Cache-Control: no-cache, no-store, must-revalidate',
    '  Pragma: no-cache',
    '  Expires: 0',
    '',
    '# Hashed JS files: cache 1 year (immutable)',
    '/*.js',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# Hashed CSS files: cache 1 year',
    '/*.css',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# Asset images: cache 1 day, revalidate',
    '/assets/*',
    '  Cache-Control: public, max-age=86400, stale-while-revalidate=604800',
    '',
  ].join('\n');

  const headersPath = path.join(outputDir, '_headers');
  await writeFile(headersPath, headersContent, 'utf8');
  console.log('  _headers written');
}

async function main() {
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
  await writeFile(path.join(outputDir, 'index.html'), indexHtml, 'utf8');
  console.log('  Updated references & API_BASE in index.html');

  await writeHeadersFile();

  console.log(`\nPages build output: ${outputDir}`);
}

main().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});

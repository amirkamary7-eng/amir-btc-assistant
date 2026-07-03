import { mkdir, cp, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'webapp', 'pages-dist');

const filesToCopy = [
  'index.html',
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

async function copyFrontendFiles() {
  for (const relativeFile of filesToCopy) {
    const source = path.join(projectRoot, relativeFile);
    const target = path.join(outputDir, relativeFile);
    await copyFile(source, target);
  }
}

async function copyAssets() {
  const sourceAssets = path.join(projectRoot, 'assets');
  const targetAssets = path.join(outputDir, 'assets');
  await cp(sourceAssets, targetAssets, { recursive: true });
}

async function injectApiBase() {
  const outputIndexPath = path.join(outputDir, 'index.html');
  const outputIndexContent = await readFile(outputIndexPath, 'utf8');
  const workerApiUrl = process.env.WORKER_API_URL?.trim();
  const apiBaseScript = workerApiUrl
    ? `<script>window.API_BASE = "${workerApiUrl}";</script>`
    : '<script>window.API_BASE = window.API_BASE || window.location.origin;</script>';

  const updatedIndexContent = outputIndexContent.replace(
    /<script>window\.API_BASE = .*?<\/script>/,
    apiBaseScript,
  );

  await writeFile(outputIndexPath, updatedIndexContent, 'utf8');
}

async function main() {
  await ensureCleanOutput();
  await copyFrontendFiles();
  await copyAssets();
  await injectApiBase();

  console.log(`Pages build output آماده شد: ${outputDir}`);
}

main().catch((error) => {
  console.error('خطا در آماده‌سازی خروجی Pages:', error);
  process.exit(1);
});

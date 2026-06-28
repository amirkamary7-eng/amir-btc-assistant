import { mkdir, cp, copyFile, rm } from 'node:fs/promises';
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

async function main() {
  await ensureCleanOutput();
  await copyFrontendFiles();
  await copyAssets();

  console.log(`Pages build output آماده شد: ${outputDir}`);
}

main().catch((error) => {
  console.error('خطا در آماده‌سازی خروجی Pages:', error);
  process.exit(1);
});

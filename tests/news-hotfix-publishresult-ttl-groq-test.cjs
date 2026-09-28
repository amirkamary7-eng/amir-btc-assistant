// ============================================================================
// HOTFIX 2.5 REGRESSION TESTS — publishResult scope + TTL config + groq stats
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const WRANGLER_PATH = path.join(__dirname, '..', 'wrangler.jsonc');
// PATH FIX (Step-5 extraction): succeedWithSummary + publishArticleToFarsiNews moved to src/news/summary.js
const SUMMARY_PATH = path.join(__dirname, '..', 'src', 'news', 'summary.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');
const wrangler = fs.readFileSync(WRANGLER_PATH, 'utf8');
const SUMMARY_SRC = fs.readFileSync(SUMMARY_PATH, 'utf8');

// Test A: publishResult declared outside try block
test('HOTFIX25-A: publishResult is declared OUTSIDE the try block in succeedWithSummary', () => {
  // PATH FIX: succeedWithSummary extracted to src/news/summary.js
  const fnStart = SUMMARY_SRC.indexOf('async function succeedWithSummary');
  assert.ok(fnStart > -1, 'succeedWithSummary must exist');
  const fnBlock = SUMMARY_SRC.slice(fnStart, fnStart + 2000);

  // Find the outer try position
  const outerTryIdx = fnBlock.indexOf('try {');
  assert.ok(outerTryIdx > -1, 'Must have try block');

  // Find publishResult declaration
  const publishResultIdx = fnBlock.indexOf('let publishResult = null');
  assert.ok(publishResultIdx > -1, 'Must have publishResult declaration');

  // publishResult must be BEFORE the outer try
  assert.ok(publishResultIdx < outerTryIdx,
    'publishResult must be declared BEFORE the outer try block (was inside, causing ReferenceError)');

  // Verify the FIX comment exists
  assert.ok(/FIX.*Commit 2.5/.test(fnBlock),
    'Must have FIX (Commit 2.5) comment');
});

// Test B: publishResult references in return statement work (no ReferenceError)
test('HOTFIX25-B: succeedWithSummary return statement references publishResult (now in scope)', () => {
  // PATH FIX: succeedWithSummary extracted to src/news/summary.js
  const fnStart = SUMMARY_SRC.indexOf('async function succeedWithSummary');
  const fnBlock = SUMMARY_SRC.slice(fnStart, fnStart + 8000);

  // The return statement must reference publishResult
  assert.ok(/published:\s*publishResult\?\.published/.test(fnBlock),
    'Return must reference publishResult.published');
  assert.ok(/published_at:\s*publishResult\?\.published_at/.test(fnBlock),
    'Return must reference publishResult.published_at');
  assert.ok(/discovery_to_publish_ms/.test(fnBlock),
    'Return must reference discovery_to_publish_ms');
});

// Test C: NEWS_CACHE_TTL in wrangler.jsonc (production=1800 is INTENTIONAL per CI NEWS-P3-011)
test('HOTFIX25-C: NEWS_CACHE_TTL values in wrangler.jsonc match intentional config', () => {
  const matches = wrangler.match(/"NEWS_CACHE_TTL":\s*(\d+)/g);
  assert.ok(matches && matches.length >= 3,
    'Must have at least 3 occurrences of NEWS_CACHE_TTL');

  // Production env intentionally uses 1800 (30 min) per CI test NEWS-P3-011.
  // Staging/preview envs use 86400 (24 hours).
  // Verify: at least one 86400 (dev/staging) AND at least one 1800 (production).
  const values = matches.map(m => parseInt(m.match(/\d+/)[0]));
  assert.ok(values.includes(86400), 'At least one env must have 86400 (staging/preview)');
  assert.ok(values.includes(1800), 'Production env must have 1800 (intentional per CI NEWS-P3-011)');
});

// Test E: Publication gate remains intact
test('HOTFIX25-E: Publication gate remains intact', () => {
  // PATH FIX: publishArticleToFarsiNews + PUBLICATION GATE extracted to src/news/summary.js
  // (sub-3 readyOnly is OBSOLETE — removed in Commit 2.6; not checked)
  assert.ok(SUMMARY_SRC.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist');
  assert.ok(SUMMARY_SRC.includes('PUBLICATION GATE (Commit 1)'),
    'Publication gate comments must remain');
});

// Test F: No duplicate publishResult declaration inside try blocks
test('HOTFIX25-F: Only ONE actual code declaration of publishResult (comments excluded)', () => {
  // PATH FIX: succeedWithSummary (the sole home of `let publishResult`) extracted to src/news/summary.js
  // Strip comments before checking
  const codeOnly = SUMMARY_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const matches = codeOnly.match(/let\s+publishResult/g);
  assert.ok(matches && matches.length === 1,
    `Must have exactly 1 'let publishResult' in code, found ${matches ? matches.length : 0}`);
});

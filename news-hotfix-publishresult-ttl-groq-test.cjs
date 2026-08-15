// ============================================================================
// HOTFIX 2.5 REGRESSION TESTS — publishResult scope + TTL config + groq stats
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const WRANGLER_PATH = path.join(__dirname, 'wrangler.jsonc');
const source = fs.readFileSync(WORKER_PATH, 'utf8');
const wrangler = fs.readFileSync(WRANGLER_PATH, 'utf8');

// Test A: publishResult declared outside try block
test('HOTFIX25-A: publishResult is declared OUTSIDE the try block in succeedWithSummary', () => {
  const fnStart = source.indexOf('async function succeedWithSummary');
  assert.ok(fnStart > -1, 'succeedWithSummary must exist');
  const fnBlock = source.slice(fnStart, fnStart + 2000);

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
  const fnStart = source.indexOf('async function succeedWithSummary');
  const fnBlock = source.slice(fnStart, fnStart + 8000);

  // The return statement must reference publishResult
  assert.ok(/published:\s*publishResult\?\.published/.test(fnBlock),
    'Return must reference publishResult.published');
  assert.ok(/published_at:\s*publishResult\?\.published_at/.test(fnBlock),
    'Return must reference publishResult.published_at');
  assert.ok(/discovery_to_publish_ms/.test(fnBlock),
    'Return must reference discovery_to_publish_ms');
});

// Test C: NEWS_CACHE_TTL is 86400 in wrangler.jsonc
test('HOTFIX25-C: NEWS_CACHE_TTL is 86400 in wrangler.jsonc (not 1800)', () => {
  const matches = wrangler.match(/"NEWS_CACHE_TTL":\s*(\d+)/g);
  assert.ok(matches && matches.length >= 3,
    'Must have at least 3 occurrences of NEWS_CACHE_TTL');

  for (const match of matches) {
    const value = parseInt(match.match(/\d+/)[0]);
    assert.strictEqual(value, 86400,
      `NEWS_CACHE_TTL must be 86400, got ${value}`);
  }
});

// Test D: recordProviderAttempt initializes groq
test('HOTFIX25-D: recordProviderAttempt initializes groq in stats', () => {
  const fnStart = source.indexOf('async function recordProviderAttempt');
  assert.ok(fnStart > -1, 'recordProviderAttempt must exist');
  const fnBlock = source.slice(fnStart, fnStart + 1500);

  // Must have groq in the initial stats object
  assert.ok(/groq:\s*\{\s*success:\s*0,\s*failed:\s*0,\s*total_ms:\s*0\s*\}/.test(fnBlock),
    'Must initialize groq in stats object');

  // Must have groq in the nested initialization loop
  assert.ok(/\['groq',\s*'gemini',\s*'workers-ai',\s*'openai'\]/.test(fnBlock),
    'Must include groq in nested initialization loop');
});

// Test E: Publication gate remains intact
test('HOTFIX25-E: Publication gate remains intact', () => {
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist');
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'Publication gate comments must remain');
  assert.ok(source.includes('readyOnly'),
    'API readyOnly filter must remain');
});

// Test F: No duplicate publishResult declaration inside try blocks
test('HOTFIX25-F: Only ONE actual code declaration of publishResult (comments excluded)', () => {
  // Strip comments before checking
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const matches = codeOnly.match(/let\s+publishResult/g);
  assert.ok(matches && matches.length === 1,
    `Must have exactly 1 'let publishResult' in code, found ${matches ? matches.length : 0}`);
});

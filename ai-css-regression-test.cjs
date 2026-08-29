/**
 * ai.css Extraction — Regression Test (Phase 1)
 * ===============================================
 * Verifies that AI Assistant CSS was correctly extracted from style.css
 * into ai.css with no regressions.
 *
 * Run: node --test ai-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiSrc = fs.readFileSync(path.join(__dirname, 'ai.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// AI selectors in ai.css
// ============================================================================

const AI_SELECTORS = [
  '.ai-assistant-root', '.ai-fab', '.ai-fab-halo', '.ai-fab-ring',
  '.ai-fab-surface', '.ai-fab-hidden', '.ai-close-btn', '.ai-bubble-avatar',
  '.ai-bubble-close', '.ai-bubble-cta', '.ai-bubble-header', '.ai-bubble-tail',
  '.ai-bubble-title', '.ai-avatar-mini', '.ai-empty-hero', '.ai-empty-icon',
  '.ai-empty-state', '.ai-empty-subtitle', '.ai-empty-title', '.ai-attach-btn',
  '.ai-composer-attachment', '.ai-file-compressing', '.ai-file-preview',
  '.ai-file-preview-header', '.ai-file-preview-info', '.ai-file-preview-name',
  '.ai-file-preview-size-row', '.ai-file-preview-status', '.ai-file-preview-thumb',
  '.ai-welcome-row', '.ai-welcome-bubble'
];

for (const sel of AI_SELECTORS) {
  test(`AI: ai.css has ${sel}`, () => {
    assert.ok(aiSrc.includes(sel), `ai.css must contain ${sel}`);
  });
}

// @keyframes for AI
const AI_KEYFRAMES = [
  'ai-halo-pulse', 'ai-fab-float', 'ai-bubble-in', 'ai-status-pulse',
  'ai-quota-pulse', 'ai-popover-in', 'ai-file-shimmer', 'ai-spin',
  'ai-msg-in', 'ai-typing-bounce', 'ai-empty-rotate'
];

for (const kf of AI_KEYFRAMES) {
  test(`AI-KF: ai.css has @keyframes ${kf}`, () => {
    assert.match(aiSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// style.css must NOT have any .ai- definitions
test('STYLE: style.css has 0 .ai- selectors', () => {
  const aiDefs = styleSrc.match(/^\.ai-/gm) || [];
  assert.equal(aiDefs.length, 0, `style.css must NOT define any .ai- selectors — found ${aiDefs.length}`);
});

test('STYLE: style.css has 0 @keyframes ai-*', () => {
  assert.ok(!/@keyframes\s+ai-/.test(styleSrc), 'style.css must NOT have any @keyframes ai-*');
});

test('STYLE: style.css has 0 #region AI Assistant', () => {
  assert.ok(!styleSrc.includes('#region AI Assistant'), 'style.css must NOT have #region AI Assistant');
});

test('STYLE: style.css has 0 .ai-welcome-row', () => {
  assert.ok(!styleSrc.includes('.ai-welcome-row'), 'style.css must NOT have .ai-welcome-row');
});

test('STYLE: style.css has 0 .ai-welcome-bubble', () => {
  assert.ok(!styleSrc.includes('.ai-welcome-bubble'), 'style.css must NOT have .ai-welcome-bubble');
});

// KEPT: Admin entry button (was right after AI block, must stay in style.css)
test('KEEP: style.css still has .admin-entry-btn', () => {
  assert.ok(styleSrc.includes('.admin-entry-btn'), 'style.css must keep .admin-entry-btn (Admin Panel, not AI)');
});

test('KEEP: style.css still has R4: Admin Panel', () => {
  assert.ok(styleSrc.includes('R4: Admin Panel'), 'style.css must keep R4: Admin Panel section');
});

// KEPT: .market-ticker and other shared components
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

// No duplication with other extracted CSS files
test('NO-DUP: .ai-assistant-root NOT in base.css or components.css', () => {
  assert.ok(!/\.ai-assistant-root/.test(baseSrc));
  assert.ok(!/\.ai-assistant-root/.test(compSrc));
});

// Load order
test('HTML: ai.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="ai\.css">/);
});

test('HTML: ai.css loads AFTER membership.css', () => {
  assert.ok(htmlSrc.indexOf('membership.css') < htmlSrc.indexOf('ai.css'),
    'ai.css must load AFTER membership.css');
});

test('HTML: ai.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('ai.css') < htmlSrc.indexOf('style.css'),
    'ai.css must load BEFORE style.css');
});

// Build pipeline
test('BUILD: ai.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'ai\.css'/);
});

test('BUILD: ai.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'ai.css'") < buildSrc.indexOf("'style.css'"),
    'ai.css must be listed before style.css in hashedFiles array');
});

// CSS integrity
test('INTEGRITY: ai.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of aiSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

// Size sanity
test('SIZE: ai.css has 600+ lines', () => {
  const lineCount = aiSrc.split('\n').length;
  assert.ok(lineCount >= 600, `ai.css should have 600+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 8163, should be < 7600)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 7600, `style.css should be < 7600 lines after extraction, has ${lineCount}`);
});

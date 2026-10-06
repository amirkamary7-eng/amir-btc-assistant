/**
 * WALLET TIER VISUAL REGRESSION TEST — TV-series
 *
 * PHASE 1 (WALLET VISUAL TIER) suite — the CSS bridge (RC-1).
 *
 * Root cause locked down: wallet.css hardcoded --w-tier-color/--w-tier-rgb to
 * Bronze (#CD7F32 / 205,127,50) while applyTierVars() (shared-utils.js) sets
 * --tier-color/--tier-rgb — vars wallet.css never consumed. Every wallet
 * visual therefore stayed Bronze at every tier. referral.css HAS the bridge,
 * which is why the Referral page colored correctly while Wallet did not.
 *
 * Coverage:
 *   TV-01/TV-02  wallet.css bridges --w-tier-color/--w-tier-rgb to the
 *                runtime --tier-* vars, keeping the exact Bronze fallback
 *                (pre-fix appearance preserved when no tier is applied).
 *   TV-03        no un-bridged (directly hardcoded) --w-tier-* definition
 *                remains — the RC-1 pattern cannot silently return.
 *   TV-04        the ~80 --w-tier-* consumers are intact (no visual
 *                regressions from removing consumers instead of bridging).
 *   TV-05        referral.css bridge untouched (no cross-contamination).
 *   TV-06/TV-07  wallet.js applies tier vars on BOTH surfaces (profile card +
 *                wallet page) — the JS half of the visual pipeline.
 *   TV-08        the fallback VALUES are exactly the old Bronze constants.
 *   TV-09        no hardcoded tier hex color was introduced in wallet.js.
 *   TV-10        tier-utils contract: shared-utils TIER_DATA palette unchanged.
 *
 * Run: node --test tests/wallet-tier-visual-regression-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WALLET_CSS = fs.readFileSync(path.join(ROOT, 'wallet.css'), 'utf8');
const REFERRAL_CSS = fs.readFileSync(path.join(ROOT, 'referral.css'), 'utf8');
const WALLET_JS = fs.readFileSync(path.join(ROOT, 'wallet.js'), 'utf8');
const SHARED_UTILS = fs.readFileSync(path.join(ROOT, 'shared-utils.js'), 'utf8');

// ============================================================================
// The bridge (RC-1 fix)
// ============================================================================

test('TV-01: wallet.css bridges --w-tier-color to the runtime --tier-color', () => {
  assert.match(
    WALLET_CSS,
    /--w-tier-color:\s*var\(--tier-color,\s*#CD7F32\)/,
    'wallet.css must define --w-tier-color: var(--tier-color, #CD7F32) — ' +
    'consuming the runtime vars that applyTierVars() sets');
});

test('TV-02: wallet.css bridges --w-tier-rgb to the runtime --tier-rgb', () => {
  assert.match(
    WALLET_CSS,
    /--w-tier-rgb:\s*var\(--tier-rgb,\s*205,\s*127,\s*50\)/,
    'wallet.css must define --w-tier-rgb: var(--tier-rgb, 205, 127, 50)');
});

test('TV-03: no directly hardcoded --w-tier-* definition remains (RC-1 pattern dead)', () => {
  // The old bug: `--w-tier-color: #CD7F32;` — a static Bronze that ignored
  // the runtime tier. The bridged form contains "var(" — anything else fails.
  const defs = WALLET_CSS.match(/--w-tier-color:\s*[^;]+;/g) || [];
  assert.ok(defs.length >= 1, 'wallet.css must define --w-tier-color');
  for (const d of defs) {
    assert.match(d, /var\(--tier-color/, `definition "${d}" must bridge to var(--tier-color, ...)`);
  }
  const rgbDefs = WALLET_CSS.match(/--w-tier-rgb:\s*[^;]+;/g) || [];
  assert.ok(rgbDefs.length >= 1, 'wallet.css must define --w-tier-rgb');
  for (const d of rgbDefs) {
    assert.match(d, /var\(--tier-rgb/, `definition "${d}" must bridge to var(--tier-rgb, ...)`);
  }
});

test('TV-04: --w-tier-* consumers intact (border/glow/badge/bar visuals kept)', () => {
  const consumers = WALLET_CSS.match(/var\(--w-tier-(?:color|rgb)/g) || [];
  // Pre-fix baseline was ~80 consumer usages (two of which are the bridge
  // definitions themselves). The fix must REMOVE ZERO consumers.
  assert.ok(consumers.length >= 70,
    `expected ≥70 var(--w-tier-*) consumer usages, found ${consumers.length}`);
});

test('TV-05: fallbacks are EXACTLY the pre-fix Bronze constants (appearance preserved pre-hydration)', () => {
  // When no runtime tier is applied (skeleton/guest/pre-hydration), the
  // bridge must fall back to the same values the old hardcoded CSS had.
  const colorBridge = WALLET_CSS.match(/--w-tier-color:\s*var\(--tier-color,\s*([^)]+)\)/);
  assert.ok(colorBridge, 'bridge must exist');
  assert.equal(colorBridge[1].trim(), '#CD7F32');
  const rgbBridge = WALLET_CSS.match(/--w-tier-rgb:\s*var\(--tier-rgb,\s*([^)]+)\)/);
  assert.ok(rgbBridge, 'rgb bridge must exist');
  assert.equal(rgbBridge[1].trim(), '205, 127, 50');
});

// ============================================================================
// No cross-contamination with referral.css
// ============================================================================

test('TV-06: referral.css bridge untouched (independent --rc-* namespace)', () => {
  assert.match(REFERRAL_CSS, /--tier-color:\s*var\(--rc-tier-color\)/,
    'referral.css keeps its own bridge');
  assert.match(REFERRAL_CSS, /--tier-rgb:\s*var\(--rc-tier-rgb\)/);
  // wallet.css must NOT import referral's namespace
  assert.ok(!/var\(--rc-tier/.test(WALLET_CSS),
    'wallet.css must not consume referral-scoped --rc-tier vars');
});

// ============================================================================
// JS half of the visual pipeline
// ============================================================================

test('TV-07: renderProfileCard applies tier vars on the profile card', () => {
  assert.match(WALLET_JS, /applyTierVars\(card,\s*tier\.current\)/,
    'renderProfileCard must call applyTierVars(card, tier.current)');
});

test('TV-08: renderWalletPage applies tier vars on the wallet page', () => {
  assert.match(WALLET_JS, /applyTierVars\(page,\s*tier\.current\)/,
    'renderWalletPage must call applyTierVars(page, tier.current)');
});

test('TV-09: _syncTierVisuals exists and recolors BOTH surfaces', () => {
  assert.match(WALLET_JS, /function _syncTierVisuals\(tier\)/,
    '_syncTierVisuals must exist (targeted tier DOM sync)');
  const count = (WALLET_JS.match(/_syncTierVisuals\(/g) || []).length;
  assert.ok(count >= 4, // definition + ≥3 call sites (claim, VPN, refresh)
    `expected ≥4 _syncTierVisuals occurrences (def + calls), found ${count}`);
});

test('TV-10: no hardcoded tier hex color in wallet.js (colors only via shared palette)', () => {
  assert.ok(!WALLET_JS.includes('#CD7F32'),
    'wallet.js must not hardcode tier hex colors — use getTierColor()/applyTierVars()');
  assert.ok(!WALLET_JS.includes('#FFD700') && !WALLET_JS.includes('#00CED1') && !WALLET_JS.includes('#C0C0C0'),
    'wallet.js must not hardcode any tier hex color');
});

// ============================================================================
// Shared palette contract (ties this suite to tier-utils-regression-test.cjs)
// ============================================================================

test('TV-11: shared-utils TIER_DATA palette unchanged (5 tiers incl. platinum)', () => {
  assert.match(SHARED_UTILS, /bronze:\s*\{\s*hex:\s*'#CD7F32',\s*rgb:\s*'205, 127, 50'\s*\}/);
  assert.match(SHARED_UTILS, /silver:\s*\{\s*hex:\s*'#C0C0C0',\s*rgb:\s*'192, 192, 192'\s*\}/);
  assert.match(SHARED_UTILS, /gold:\s*\{\s*hex:\s*'#FFD700',\s*rgb:\s*'255, 215, 0'\s*\}/);
  assert.match(SHARED_UTILS, /platinum:\s*\{\s*hex:\s*'#6CB4EE',\s*rgb:\s*'108, 180, 238'\s*\}/);
  assert.match(SHARED_UTILS, /diamond:\s*\{\s*hex:\s*'#00CED1',\s*rgb:\s*'0, 206, 209'\s*\}/);
});

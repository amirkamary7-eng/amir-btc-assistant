/**
 * membership.css Extraction — Regression Test (Phase 8)
 * ======================================================
 * Verifies that Membership / Profile / Join-Lock CSS was correctly
 * extracted from style.css into membership.css with no regressions.
 *
 * Run: node --test membership-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mbSrc = fs.readFileSync(path.join(__dirname, 'membership.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const marketSrc = fs.readFileSync(path.join(__dirname, 'market.css'), 'utf8');
const newsSrc = fs.readFileSync(path.join(__dirname, 'news.css'), 'utf8');
const cdSrc = fs.readFileSync(path.join(__dirname, 'coin-detail.css'), 'utf8');
const tkSrc = fs.readFileSync(path.join(__dirname, 'tickets.css'), 'utf8');
const walletSrc = fs.readFileSync(path.join(__dirname, 'wallet.css'), 'utf8');
const refSrc = fs.readFileSync(path.join(__dirname, 'referral.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// Block A — Join-Lock selectors in membership.css
// ============================================================================

const JL_SELECTORS = [
  'body.jl-locked',
  '.join-status-bar',
  '.join-status-bar.visible',
  '.jsb-inner',
  '.jsb-icon',
  '.jsb-spinner',
  '.jsb-text',
  '.jsb-action',
  '.join-lock-overlay',
  '.join-lock-card',
  '.join-lock-icon-scene',
  '.join-lock-icon-glow',
  '.join-lock-icon-ring',
  '.join-lock-icon',
  '.join-lock-badge',
  '.join-lock-title',
  '.join-lock-desc',
  '.join-lock-actions',
  '.join-lock-channels',
  '.jl-channels-header',
  '.jl-channel-row',
  '.jl-channel-dot',
  '.jl-channel-info',
  '.jl-channel-title',
  '.jl-channel-uname',
  '.jl-channel-join',
  '.join-lock-btn',
  '.join-lock-btn-primary',
  '.join-lock-btn-secondary',
  '.join-lock-loading',
  '.join-lock-spinner',
  '.join-lock-error'
];

for (const sel of JL_SELECTORS) {
  test(`JL: membership.css has ${sel}`, () => {
    assert.ok(mbSrc.includes(sel), `membership.css must contain ${sel}`);
  });
}

// @keyframes for Join-Lock
const JL_KEYFRAMES = ['jsbSpin', 'jlFadeIn', 'jlCardIn', 'jlRingPulse', 'jlGlowPulse', 'jlIconFloat', 'jlSpin', 'jlShake'];
for (const kf of JL_KEYFRAMES) {
  test(`JL-KF: membership.css has @keyframes ${kf}`, () => {
    assert.match(mbSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// style.css must NOT have join-lock / jsb definitions
test('STYLE: style.css has 0 body.jl-locked', () => {
  assert.ok(!styleSrc.includes('body.jl-locked'), 'style.css must NOT have body.jl-locked (moved to membership.css)');
});
test('STYLE: style.css has 0 .join-status-bar', () => {
  assert.ok(!styleSrc.includes('.join-status-bar'), 'style.css must NOT have .join-status-bar');
});
test('STYLE: style.css has 0 .jsb- selectors', () => {
  const defs = styleSrc.match(/\.jsb-/g) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .jsb- selectors — found ${defs.length}`);
});
test('STYLE: style.css has 0 .join-lock- selectors', () => {
  const defs = styleSrc.match(/\.join-lock-/g) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .join-lock- selectors — found ${defs.length}`);
});
test('STYLE: style.css has 0 .jl-channel selectors', () => {
  const defs = styleSrc.match(/\.jl-channel/g) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .jl-channel selectors — found ${defs.length}`);
});
test('STYLE: style.css has 0 @keyframes jsbSpin', () => {
  assert.ok(!/@keyframes\s+jsbSpin/.test(styleSrc), 'style.css must NOT have @keyframes jsbSpin');
});
test('STYLE: style.css has 0 @keyframes jlFadeIn', () => {
  assert.ok(!/@keyframes\s+jlFadeIn/.test(styleSrc), 'style.css must NOT have @keyframes jlFadeIn');
});

// ============================================================================
// Block B — Membership Module selectors in membership.css
// ============================================================================

const MB_SELECTORS = [
  '.profile-card.profile-card--premium',
  '.membership-badge',
  '.membership-badge--free',
  '.membership-badge--premium',
  '.membership-badge--loading',
  '.mb-diamond',
  '.mb-diamond-svg',
  '.mb-badge-skeleton',
  '.mb-popup-overlay',
  '.mb-popup',
  '.mb-popup-close',
  '.mb-popup-header',
  '.mb-popup-diamond',
  '.mb-popup-title',
  '.mb-popup-subtitle',
  '.mb-benefits',
  '.mb-benefit',
  '.mb-benefit-icon',
  '.mb-benefit-text',
  '.mb-benefit-title',
  '.mb-benefit-desc',
  '.mb-timeline',
  '.mb-timeline-item',
  '.mb-timeline-step',
  '.mb-timeline-text',
  '.mb-timeline-note',
  '.mb-cta-register',
  '.mb-uid-form',
  '.mb-uid-label',
  '.mb-uid-input',
  '.mb-uid-submit',
  '.mb-rules-section',
  '.mb-rules-header',
  '.mb-rules-title',
  '.mb-rules-body',
  '.mb-rules-accept',
  '.mb-rules-checkbox',
  '.mb-rules-modal-overlay',
  '.mb-rules-modal',
  '.mb-rules-modal-body',
  '.mb-rules-modal-ok',
  '.mb-ra-item',
  '.mb-ra-header',
  '.mb-ra-chevron',
  '.mb-ra-body',
  '.mb-success',
  '.mb-success-icon',
  '.mb-success-title',
  '.mb-success-msg',
  '.mb-pending',
  '.mb-pending-icon',
  '.mb-pending-title',
  '.mb-pending-msg',
  '.mb-pending-progress',
  '.mb-pending-progress-bar',
  '.mb-vip-status',
  '.mb-vip-badge',
  '.mb-vip-badge-text',
  '.mb-vip-info',
  '.mb-vip-info-item',
  '.mb-vip-info-label',
  '.mb-vip-info-val',
  '.mb-vip-lifetime',
  '.mb-welcome-overlay',
  '.mb-welcome-card',
  '.mb-welcome-bg-blur',
  '.mb-welcome-sparkle',
  '.mb-welcome-content',
  '.mb-welcome-diamond-wrap',
  '.mb-welcome-diamond-halo',
  '.mb-welcome-diamond-glow',
  '.mb-welcome-diamond-icon',
  '.mb-welcome-badge',
  '.mb-welcome-title',
  '.mb-welcome-subtitle',
  '.mb-welcome-desc',
  '.mb-welcome-benefits',
  '.mb-welcome-benefit',
  '.mb-welcome-cta'
];

for (const sel of MB_SELECTORS) {
  test(`MB: membership.css has ${sel}`, () => {
    assert.ok(mbSrc.includes(sel), `membership.css must contain ${sel}`);
  });
}

// @keyframes for Membership Module
const MB_KEYFRAMES = ['mb-card-breathing', 'mb-card-shine', 'mb-free-pulse', 'mb-glow-pulse', 'mb-pulse-ring', 'mb-diamond-float', 'mb-shimmer-sweep'];
for (const kf of MB_KEYFRAMES) {
  test(`MB-KF: membership.css has @keyframes ${kf}`, () => {
    assert.match(mbSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// style.css must NOT have these membership selectors as definitions
test('STYLE: style.css has 0 .membership-badge { definitions', () => {
  assert.ok(!/\.membership-badge\s*\{/.test(styleSrc), 'style.css must NOT define .membership-badge (moved to membership.css)');
});
test('STYLE: style.css has 0 .mb-popup { definitions', () => {
  assert.ok(!/\.mb-popup\s*\{/.test(styleSrc), 'style.css must NOT define .mb-popup');
});
test('STYLE: style.css has 0 .mb-welcome-overlay definitions', () => {
  assert.ok(!/\.mb-welcome-overlay/.test(styleSrc), 'style.css must NOT define .mb-welcome-overlay');
});
test('STYLE: style.css has 0 .mb-rules-modal definitions', () => {
  assert.ok(!/\.mb-rules-modal/.test(styleSrc), 'style.css must NOT define .mb-rules-modal');
});
test('STYLE: style.css has 0 .mb-uid-form definitions', () => {
  assert.ok(!/\.mb-uid-form/.test(styleSrc), 'style.css must NOT define .mb-uid-form');
});
test('STYLE: style.css has 0 .mb-timeline definitions', () => {
  assert.ok(!/\.mb-timeline/.test(styleSrc), 'style.css must NOT define .mb-timeline');
});
test('STYLE: style.css has 0 .mb-success definitions', () => {
  assert.ok(!/\.mb-success/.test(styleSrc), 'style.css must NOT define .mb-success');
});
test('STYLE: style.css has 0 .mb-pending definitions', () => {
  assert.ok(!/\.mb-pending/.test(styleSrc), 'style.css must NOT define .mb-pending');
});
test('STYLE: style.css has 0 .mb-vip-status definitions', () => {
  assert.ok(!/\.mb-vip-status/.test(styleSrc), 'style.css must NOT define .mb-vip-status');
});
test('STYLE: style.css has 0 .profile-card.profile-card--premium definitions', () => {
  assert.ok(!/\.profile-card\.profile-card--premium/.test(styleSrc), 'style.css must NOT define .profile-card.profile-card--premium (moved to membership.css)');
});
test('STYLE: style.css has 0 @keyframes mb-card-breathing', () => {
  assert.ok(!/@keyframes\s+mb-card-breathing/.test(styleSrc), 'style.css must NOT have @keyframes mb-card-breathing');
});
test('STYLE: style.css has 0 @keyframes mb-diamond-float', () => {
  assert.ok(!/@keyframes\s+mb-diamond-float/.test(styleSrc), 'style.css must NOT have @keyframes mb-diamond-float');
});

// ============================================================================
// Preserved in style.css (NOT extracted — ambiguous/interleaved/shared)
// ============================================================================

test('KEEP: style.css still has .profile-card base', () => {
  assert.match(styleSrc, /\.profile-card\s*\{/);
});
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});
test('KEEP: style.css still has .mb-vip-cosmetic (Block C — interleaved with cosmetics)', () => {
  assert.ok(styleSrc.includes('.mb-vip-cosmetic'), 'style.css must keep .mb-vip-cosmetic (Block C — ambiguous, kept)');
});
test('KEEP: style.css still has .mb-vip-quotas (Block C)', () => {
  assert.ok(styleSrc.includes('.mb-vip-quotas'), 'style.css must keep .mb-vip-quotas (Block C)');
});
test('KEEP: style.css still has .mb-quota-preview (Block C)', () => {
  assert.ok(styleSrc.includes('.mb-quota-preview'), 'style.css must keep .mb-quota-preview (Block C)');
});
test('KEEP: style.css still has .cosmetics-entry-btn', () => {
  assert.ok(styleSrc.includes('.cosmetics-entry-btn'), 'style.css must keep .cosmetics-entry-btn');
});
test('KEEP: style.css still has @keyframes fadeIn (shared)', () => {
  assert.match(styleSrc, /@keyframes\s+fadeIn/);
});
test('KEEP: style.css still has @keyframes slideUp (shared)', () => {
  assert.match(styleSrc, /@keyframes\s+slideUp/);
});

// ============================================================================
// No duplication with other extracted CSS files
// ============================================================================

const otherCss = { baseSrc, compSrc, dashSrc, marketSrc, newsSrc, cdSrc, tkSrc, walletSrc, refSrc };
const otherNames = { baseSrc: 'base.css', compSrc: 'components.css', dashSrc: 'dashboard.css', marketSrc: 'market.css', newsSrc: 'news.css', cdSrc: 'coin-detail.css', tkSrc: 'tickets.css', walletSrc: 'wallet.css', refSrc: 'referral.css' };

const overlapChecks = [
  ['.membership-badge', 'membership-badge'],
  ['.mb-popup', 'mb-popup'],
  ['.mb-welcome', 'mb-welcome'],
  ['.join-lock', 'join-lock'],
  ['.jsb-', 'jsb-'],
  ['.jl-channel', 'jl-channel']
];

for (const [sel, token] of overlapChecks) {
  test(`NO-DUP: ${sel} NOT in any other extracted CSS`, () => {
    for (const [src, name] of Object.entries(otherNames)) {
      assert.ok(!otherCss[src].includes(token), `${name} must NOT contain "${token}" (membership namespace)`);
    }
  });
}

// ============================================================================
// Load order in index.html
// ============================================================================

test('HTML: membership.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="membership\.css">/);
});
test('HTML: membership.css loads AFTER tickets.css', () => {
  assert.ok(htmlSrc.indexOf('tickets.css') < htmlSrc.indexOf('membership.css'),
    'membership.css must load AFTER tickets.css');
});
test('HTML: membership.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('membership.css') < htmlSrc.indexOf('style.css'),
    'membership.css must load BEFORE style.css');
});

// ============================================================================
// Build pipeline
// ============================================================================

test('BUILD: membership.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'membership\.css'/);
});
test('BUILD: membership.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'membership.css'") < buildSrc.indexOf("'style.css'"),
    'membership.css must be listed before style.css in hashedFiles array');
});

// ============================================================================
// CSS custom property (used by join-status-bar)
// ============================================================================

test('CSS-VAR: membership.css has --jsb-bottom-offset', () => {
  assert.match(mbSrc, /--jsb-bottom-offset/);
});

// ============================================================================
// File size sanity checks
// ============================================================================

test('SIZE: membership.css has 1500+ lines', () => {
  const lineCount = mbSrc.split('\n').length;
  assert.ok(lineCount >= 1500, `membership.css should have 1500+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 11092, should be < 9800)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 9800, `style.css should be < 9800 lines after extraction, has ${lineCount}`);
});

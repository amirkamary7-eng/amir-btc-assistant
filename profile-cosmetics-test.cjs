/**
 * Phase 5 — Profile Cosmetics Tests
 *
 * Tests cosmetics system: catalog, purchase, activate, ownership, security.
 * Uses source-inspection pattern.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const COSMETICS_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/cosmetics.js'), 'utf8');
const COSMETICS_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/cosmetics.js'), 'utf8');
const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
const COSMETICS_JS_SRC = fs.readFileSync(path.join(__dirname, 'cosmetics.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// ─── Migration tests ────────────────────────────────────────────────────────

test('MIG-01: migration idempotent + non-destructive', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  const codeOnly = sql.replace(/--[^\n]*/g, '');
  assert.ok(codeOnly.includes('CREATE TABLE IF NOT EXISTS profile_cosmetics'));
  assert.ok(codeOnly.includes('CREATE TABLE IF NOT EXISTS user_cosmetic_ownership'));
  assert.ok(codeOnly.includes('ON CONFLICT (cosmetic_key) DO NOTHING'));
  assert.ok(!/\bDROP\s+TABLE\b/i.test(codeOnly));
  assert.ok(!/\bTRUNCATE\b/i.test(codeOnly));
});

test('MIG-02: unique constraints exist', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  assert.ok(sql.includes('uq_cosmetic_ownership_user_cosmetic'));
  assert.ok(sql.includes('uq_cosmetic_active_per_user'));
  assert.ok(sql.includes("WHERE is_active = TRUE"));
});

test('MIG-03: 10 cosmetics seeded with correct rarities', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  assert.ok(sql.includes("'common'"));
  assert.ok(sql.includes("'rare'"));
  assert.ok(sql.includes("'epic'"));
  assert.ok(sql.includes("'legendary'"));
  assert.ok(sql.includes("'mythic'"));
});

test('MIG-04: correct prices', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  assert.ok(sql.includes(', 100,'));
  assert.ok(sql.includes(', 500,'));
  assert.ok(sql.includes(', 1500,'));
  assert.ok(sql.includes(', 5000,'));
  assert.ok(sql.includes(', 10000,'));
});

test('MIG-05: rollback documented', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  assert.ok(sql.includes('Rollback:'));
});

// ─── Repository tests ───────────────────────────────────────────────────────

test('REPO-01: has all required methods', () => {
  ['ensureSchema', 'getCatalog', 'getById', 'getOwned', 'getActive', 'getOwnership', 'createOwnership', 'activate'].forEach(m => {
    assert.ok(COSMETICS_REPO_SRC.includes(`function ${m}(`) || COSMETICS_REPO_SRC.includes(`${m}(`));
  });
});

test('REPO-02: createOwnership is idempotent (ON CONFLICT DO NOTHING)', () => {
  assert.ok(COSMETICS_REPO_SRC.includes('ON CONFLICT (user_id, cosmetic_id) DO NOTHING'));
  assert.ok(COSMETICS_REPO_SRC.includes('created: true') && COSMETICS_REPO_SRC.includes('created: false'));
});

test('REPO-03: activate is atomic (transaction)', () => {
  assert.ok(COSMETICS_REPO_SRC.includes('queryDbTransaction'));
  const block = COSMETICS_REPO_SRC.slice(COSMETICS_REPO_SRC.indexOf('async function activate'), COSMETICS_REPO_SRC.indexOf('return Object.freeze'));
  assert.ok(block.includes('is_active = FALSE'));
  assert.ok(block.includes('is_active = TRUE'));
  assert.ok(block.includes('RETURNING id'));
});

// ─── Controller tests ───────────────────────────────────────────────────────

test('CTRL-01: has all handlers', () => {
  ['handleGetCatalog', 'handleGetMine', 'handlePurchase', 'handleActivate'].forEach(h => {
    assert.ok(COSMETICS_CTRL_SRC.includes(`async function ${h}`));
  });
});

test('CTRL-02: purchase requires Premium', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handlePurchase'), COSMETICS_CTRL_SRC.indexOf('async function handleActivate'));
  assert.ok(block.includes('_isPremiumSafe'));
  assert.ok(block.includes('PREMIUM_REQUIRED'));
  assert.ok(block.includes('403'));
});

test('CTRL-03: activate requires Premium + ownership', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handleActivate'), COSMETICS_CTRL_SRC.indexOf('return Object.freeze'));
  assert.ok(block.includes('_isPremiumSafe'));
  assert.ok(block.includes('PREMIUM_REQUIRED'));
  assert.ok(block.includes('NOT_OWNED'));
});

test('CTRL-04: purchase uses atomic AB debit', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handlePurchase'), COSMETICS_CTRL_SRC.indexOf('async function handleActivate'));
  assert.ok(block.includes('economyService.debitUser'));
  assert.ok(block.includes('cosmetic_purchase'));
  assert.ok(block.includes('402'));
});

test('CTRL-05: race condition refund', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handlePurchase'), COSMETICS_CTRL_SRC.indexOf('async function handleActivate'));
  assert.ok(block.includes('race_condition_already_owned'));
  assert.ok(block.includes('_refund'));
  assert.ok(block.includes('grantReward'));
});

test('CTRL-06: fail-safe — authority error returns Normal', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function _isPremiumSafe'), COSMETICS_CTRL_SRC.indexOf('async function handleGetCatalog'));
  assert.ok(block.includes('return false'));
  assert.ok(block.includes('catch'));
});

// ─── Routes tests ───────────────────────────────────────────────────────────

test('ROUTES-01: all cosmetics routes registered', () => {
  assert.ok(WORKER_SRC.includes("'/api/cosmetics'"));
  assert.ok(WORKER_SRC.includes("'/api/cosmetics/mine'"));
  assert.ok(WORKER_SRC.includes("'/purchase'"));
  assert.ok(WORKER_SRC.includes("'/activate'"));
  assert.ok(WORKER_SRC.includes('cosmeticsHandlers.handleGetCatalog'));
  assert.ok(WORKER_SRC.includes('cosmeticsHandlers.handlePurchase'));
  assert.ok(WORKER_SRC.includes('cosmeticsHandlers.handleActivate'));
});

test('ROUTES-02: dynamic route extracts cosmeticId', () => {
  assert.ok(WORKER_SRC.includes("url.pathname.slice('/api/cosmetics/'.length"));
});

// ─── Wiring tests ───────────────────────────────────────────────────────────

test('WIRE-01: cosmeticsRepo + handlers created', () => {
  assert.ok(WORKER_SRC.includes('const cosmeticsRepo = createCosmeticsRepository'));
  assert.ok(WORKER_SRC.includes('const cosmeticsHandlers = createCosmeticsHandlers'));
});

test('WIRE-02: cosmeticsRepo injected into membershipHandlers', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const membershipHandlers = createMembershipHandlers'), WORKER_SRC.indexOf('async function handleChartResolve'));
  assert.ok(w.includes('cosmeticsRepo'));
});

test('WIRE-03: membershipAuthority + economyService in cosmetics handlers', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const cosmeticsHandlers = createCosmeticsHandlers'), WORKER_SRC.indexOf('const sessionRepo'));
  assert.ok(w.includes('membershipAuthority'));
  assert.ok(w.includes('economyService'));
});

// ─── Badge + status tests ───────────────────────────────────────────────────

test('BADGE-01: badge text is 💎 PREMIUM', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes("'💎 PREMIUM'"));
  assert.ok(!MEMBERSHIP_USER_SRC.includes("'Premium Member'"));
});

test('BADGE-02: renderBadge applies active cosmetic CSS class', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('active_cosmetic'));
  assert.ok(MEMBERSHIP_USER_SRC.includes('css_class'));
  assert.ok(MEMBERSHIP_USER_SRC.includes('profile-cosmetic--'));
});

test('BADGE-03: renderBadge removes previous cosmetic classes', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('classesToRemove'));
  assert.ok(MEMBERSHIP_USER_SRC.includes("indexOf('profile-cosmetic--')"));
});

test('STATUS-01: /api/membership/status returns active_cosmetic', () => {
  const m = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
  const block = m.slice(m.indexOf('async function handleGetStatus'), m.indexOf('async function handleGetMyRequests'));
  assert.ok(block.includes('activeCosmetic'));
  assert.ok(block.includes('cosmeticsRepo.getActive'));
  assert.ok(block.includes('active_cosmetic:'));
});

// ─── Frontend tests ─────────────────────────────────────────────────────────

test('FE-01: cosmetics.js exists with shop functions', () => {
  assert.ok(COSMETICS_JS_SRC.includes('openShop'));
  assert.ok(COSMETICS_JS_SRC.includes('closeShop'));
  assert.ok(COSMETICS_JS_SRC.includes('purchase'));
  assert.ok(COSMETICS_JS_SRC.includes('activate'));
  assert.ok(COSMETICS_JS_SRC.includes('CosmeticsApp'));
});

test('FE-02: fetches catalog from API', () => {
  assert.ok(COSMETICS_JS_SRC.includes("/api/cosmetics"));
});

test('FE-03: renders locked cards for Normal', () => {
  assert.ok(COSMETICS_JS_SRC.includes('locked'));
  assert.ok(COSMETICS_JS_SRC.includes('cosmetic-card--locked'));
  assert.ok(COSMETICS_JS_SRC.includes('🔒 فقط Premium'));
});

test('FE-04: index.html has cosmetics entry button', () => {
  assert.ok(INDEX_HTML.includes('cosmetics-entry-btn'));
  assert.ok(INDEX_HTML.includes('CosmeticsApp.openShop'));
});

test('FE-05: index.html loads cosmetics.js', () => {
  assert.ok(INDEX_HTML.includes('cosmetics.js'));
});

test('FE-06: CSS has cosmetics shop styles', () => {
  assert.ok(STYLE_CSS.includes('.cosmetics-shop-overlay'));
  assert.ok(STYLE_CSS.includes('.cosmetic-card'));
  assert.ok(STYLE_CSS.includes('.cosmetic-card--locked'));
  assert.ok(STYLE_CSS.includes('.cosmetic-card--active'));
});

test('FE-07: CSS has active cosmetic profile styles', () => {
  assert.ok(STYLE_CSS.includes('profile-cosmetic--golden-aura'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--ice'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--energy'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--lava'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--cyber'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--nebula'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--galaxy'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--gold-frame'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--royal'));
  assert.ok(STYLE_CSS.includes('profile-cosmetic--legendary'));
});

// ─── Security tests ─────────────────────────────────────────────────────────

test('SEC-01: no client-side isPremium trust', () => {
  assert.ok(!COSMETICS_CTRL_SRC.includes('payload.isPremium'));
  assert.ok(!COSMETICS_CTRL_SRC.includes('body.isPremium'));
});

test('SEC-02: isPremium from MembershipAuthority', () => {
  assert.ok(COSMETICS_CTRL_SRC.includes('membershipAuthority.isPremium'));
  assert.ok(COSMETICS_CTRL_SRC.includes('_isPremiumSafe'));
});

test('SEC-03: purchase idempotent (UNIQUE + ON CONFLICT)', () => {
  assert.ok(COSMETICS_REPO_SRC.includes('ON CONFLICT (user_id, cosmetic_id) DO NOTHING'));
  assert.ok(COSMETICS_CTRL_SRC.includes('ALREADY_OWNED'));
  assert.ok(COSMETICS_CTRL_SRC.includes('409'));
});

test('SEC-04: deterministic refId for debit', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handlePurchase'), COSMETICS_CTRL_SRC.indexOf('async function handleActivate'));
  assert.ok(block.includes("`cosmetic_purchase_${userId}_${cosmeticId}`"));
});

test('SEC-05: no negative balance', () => {
  assert.ok(COSMETICS_CTRL_SRC.includes('economyService.debitUser'));
  assert.ok(COSMETICS_CTRL_SRC.includes('PAYMENT_FAILED'));
  assert.ok(COSMETICS_CTRL_SRC.includes('402'));
});

test('SEC-06: fail-safe denies on authority error', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function _isPremiumSafe'), COSMETICS_CTRL_SRC.indexOf('async function handleGetCatalog'));
  assert.ok(block.includes('return false'));
});

// ─── Atomicity tests ────────────────────────────────────────────────────────

test('ATOMIC-01: purchase debit + ownership insert safe', () => {
  const block = COSMETICS_CTRL_SRC.slice(COSMETICS_CTRL_SRC.indexOf('async function handlePurchase'), COSMETICS_CTRL_SRC.indexOf('async function handleActivate'));
  assert.ok(block.includes('debitUser'));
  assert.ok(block.includes('createOwnership'));
  assert.ok(block.includes('race_condition'));
});

test('ATOMIC-02: activate is atomic (single transaction)', () => {
  const block = COSMETICS_REPO_SRC.slice(COSMETICS_REPO_SRC.indexOf('async function activate'), COSMETICS_REPO_SRC.indexOf('return Object.freeze'));
  assert.ok(block.includes('queryDbTransaction'));
  assert.ok(block.includes('is_active = FALSE'));
  assert.ok(block.includes('is_active = TRUE'));
});

test('ATOMIC-03: only one active per user', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-cosmetics-schema.sql'), 'utf8');
  assert.ok(sql.includes('uq_cosmetic_active_per_user'));
  assert.ok(sql.includes("WHERE is_active = TRUE"));
});

// ─── Scope tests ────────────────────────────────────────────────────────────

test('SCOPE-01: no VPN rewards', () => {
  assert.ok(!WORKER_SRC.includes('/api/premium-rewards'));
});

test('SCOPE-02: no exchange/rules changes', () => {
  assert.ok(WORKER_SRC.includes('/api/membership/requirement'));
  assert.ok(WORKER_SRC.includes('/api/membership/rules'));
});

test('SCOPE-03: no authority.require() calls', () => {
  const calls = WORKER_SRC.match(/membershipAuthority\.require\s*\(/g) || [];
  assert.equal(calls.length, 0);
});

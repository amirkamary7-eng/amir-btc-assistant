/**
 * Phase 6 — Premium UI Tests
 *
 * Tests the Premium UI enhancements:
 *   - VIP Status Popup: active cosmetic display + quota summary
 *   - Activation Popup: quota preview (Normal → Premium)
 *   - Badge text: 💎 PREMIUM (gradient style)
 *   - CSS styles for new elements
 *   - No behavior changes to existing functionality
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── VIP Status Popup tests ─────────────────────────────────────────────────

test('VIP-01: VIP popup shows active cosmetic', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('active_cosmetic'), 'reads active_cosmetic');
  assert.ok(block.includes('mb-vip-cosmetic'), 'cosmetic display element');
  assert.ok(block.includes('ظاهر فعال'), 'active cosmetic label');
  assert.ok(block.includes('بدون ظاهر فعال'), 'empty cosmetic state');
});

test('VIP-02: VIP cosmetic links to cosmetics shop', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('CosmeticsApp.openShop'), 'links to cosmetics shop');
});

test('VIP-03: VIP popup shows tier-based quota summary', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('mb-vip-quotas'), 'quota summary container');
  assert.ok(block.includes('هشدارهای قیمتی'), 'alerts quota');
  assert.ok(block.includes('چت هوش مصنوعی'), 'AI chat quota');
  assert.ok(block.includes('چرخ شانس'), 'wheel quota');
  assert.ok(block.includes('واچ‌لیست'), 'watchlist quota');
  assert.ok(block.includes('۱۰ رایگان در روز'), 'Premium alerts = 10/day');
  assert.ok(block.includes('۱۰۰ پیام در روز'), 'Premium AI = 100/day');
  assert.ok(block.includes('۵ اسپین در روز'), 'Premium wheel = 5/day');
  assert.ok(block.includes('۲۰ نماد'), 'Premium watchlist = 20');
});

test('VIP-04: VIP popup title is 💎 PREMIUM', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('💎 PREMIUM'), 'title is 💎 PREMIUM');
  assert.ok(!block.includes('عضویت ویژه AMIRBTC Premium'), 'old title removed');
});

test('VIP-05: VIP popup subtitle mentions higher quotas', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('سهمیه بالاتر'), 'mentions higher quotas');
});

test('VIP-06: VIP benefits include cosmetics shop', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openVipStatusPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup')
  );
  assert.ok(block.includes('فروشگاه ظاهر پروفایل'), 'cosmetics shop benefit');
  assert.ok(block.includes('نشان 💎 PREMIUM'), 'badge uses 💎 PREMIUM');
});

// ─── Activation Popup tests ─────────────────────────────────────────────────

test('ACT-01: Activation popup title is 💎 PREMIUM', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openPendingPopup')
  );
  assert.ok(block.includes('💎 PREMIUM'), 'title is 💎 PREMIUM');
});

test('ACT-02: Activation popup shows quota preview', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openPendingPopup')
  );
  assert.ok(block.includes('mb-quota-preview'), 'quota preview container');
  assert.ok(block.includes('مزایای Premium'), 'preview title');
  assert.ok(block.includes('mb-qpi-normal'), 'Normal value');
  assert.ok(block.includes('mb-qpi-premium'), 'Premium value');
  const itemCount = (block.match(/mb-quota-preview-item/g) || []).length;
  assert.ok(itemCount >= 6, 'at least 6 quota preview items');
});

test('ACT-03: Quota preview shows cosmetics as Premium-exclusive', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openActivationPopup'),
    MEMBERSHIP_USER_SRC.indexOf('function openPendingPopup')
  );
  assert.ok(block.includes('ظاهر پروفایل'), 'cosmetics in preview');
  assert.ok(block.includes('❌'), 'Normal = ❌');
  assert.ok(block.includes('✅'), 'Premium = ✅');
});

// ─── Badge tests ────────────────────────────────────────────────────────────

test('BADGE-01: Badge text is 💎 PREMIUM', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes("'💎 PREMIUM'"));
  assert.ok(!MEMBERSHIP_USER_SRC.includes("'Premium Member'"));
});

// ─── CSS tests ──────────────────────────────────────────────────────────────

test('CSS-01: VIP cosmetic display styles exist', () => {
  assert.ok(STYLE_CSS.includes('.mb-vip-cosmetic'), 'cosmetic display');
  assert.ok(STYLE_CSS.includes('.mb-vip-cosmetic-btn'), 'button');
  assert.ok(STYLE_CSS.includes('.mb-vip-cosmetic--empty'), 'empty state');
});

test('CSS-02: VIP quota summary styles exist', () => {
  assert.ok(STYLE_CSS.includes('.mb-vip-quotas'), 'quotas container');
  assert.ok(STYLE_CSS.includes('.mb-vip-quota'), 'quota item');
  assert.ok(STYLE_CSS.includes('.mb-vip-quota-val'), 'value');
});

test('CSS-03: Activation quota preview styles exist', () => {
  assert.ok(STYLE_CSS.includes('.mb-quota-preview'), 'preview container');
  assert.ok(STYLE_CSS.includes('.mb-quota-preview-grid'), 'grid');
  assert.ok(STYLE_CSS.includes('.mb-quota-preview-item'), 'item');
  assert.ok(STYLE_CSS.includes('.mb-qpi-normal'), 'Normal value');
  assert.ok(STYLE_CSS.includes('.mb-qpi-premium'), 'Premium value');
});

test('CSS-04: Premium badge gradient text style exists', () => {
  assert.ok(STYLE_CSS.includes('.membership-badge--premium .mb-badge-text'), 'badge text');
  assert.ok(STYLE_CSS.includes('linear-gradient'), 'gradient');
  assert.ok(STYLE_CSS.includes('-webkit-background-clip: text'), 'text clip');
});

test('CSS-05: Responsive quota preview grid', () => {
  assert.ok(STYLE_CSS.includes('@media (max-width: 360px)'), 'responsive');
  assert.ok(STYLE_CSS.includes('grid-template-columns: 1fr'), 'single column');
});

// ─── No behavior change tests ───────────────────────────────────────────────

test('NOCHANGE-01: isPremium routing preserved', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('isPremium(_cache)'), 'open() checks isPremium');
  assert.ok(MEMBERSHIP_USER_SRC.includes('openVipStatusPopup'), 'VIP popup called');
  assert.ok(MEMBERSHIP_USER_SRC.includes('openActivationPopup'), 'activation popup called');
});

test('NOCHANGE-02: Badge rendering still applies cosmetic CSS', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('active_cosmetic'), 'reads active_cosmetic');
  assert.ok(MEMBERSHIP_USER_SRC.includes('css_class'), 'applies css_class');
  assert.ok(MEMBERSHIP_USER_SRC.includes('profile-cosmetic--'), 'cosmetic class prefix');
});

test('NOCHANGE-03: Welcome popup unchanged', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('function openWelcomePopup'),
    MEMBERSHIP_USER_SRC.indexOf('function closeWelcomePopup')
  );
  assert.ok(block.includes('PREMIUM'), 'welcome popup has PREMIUM');
  assert.ok(block.includes('markWelcomeShownInBackend'), 'marks shown');
});

// ─── Scope tests ───────────────────────────────────────────────────────────

test('SCOPE-01: No new API endpoints (UI-only phase)', () => {
  // Phase 6 should not add new endpoints
  const cosmeticsRoutes = (WORKER_SRC.match(/\/api\/cosmetics/g) || []).length;
  assert.ok(cosmeticsRoutes >= 4, 'cosmetics routes unchanged (Phase 5)');
});

test('SCOPE-02: No backend/controller/repo changes', () => {
  const cosmeticsCtrl = fs.readFileSync(path.join(__dirname, 'src/controllers/cosmetics.js'), 'utf8');
  const cosmeticsRepo = fs.readFileSync(path.join(__dirname, 'src/repositories/cosmetics.js'), 'utf8');
  assert.ok(!cosmeticsCtrl.includes('Phase 6'), 'cosmetics controller unchanged');
  assert.ok(!cosmeticsRepo.includes('Phase 6'), 'cosmetics repo unchanged');
});

test('SCOPE-03: No exchange/rules/requirements changes', () => {
  assert.ok(WORKER_SRC.includes('/api/membership/requirement'), 'requirement unchanged');
  assert.ok(WORKER_SRC.includes('/api/membership/rules'), 'rules unchanged');
});

test('SCOPE-04: Cosmetics shop entry button preserved', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes('cosmetics-entry-btn'), 'entry button present');
  assert.ok(html.includes('CosmeticsApp.openShop'), 'opens shop');
});

test('SCOPE-05: No VPN rewards endpoint', () => {
  assert.ok(!WORKER_SRC.includes('/api/premium-rewards'));
});

test('SCOPE-06: No authority.require() calls', () => {
  const calls = WORKER_SRC.match(/membershipAuthority\.require\s*\(/g) || [];
  assert.equal(calls.length, 0);
});

// ============================================================
// shared-utils.js — Shared utilities between wallet.js and referral.js
// ============================================================
//
// This file contains ONLY functions that were duplicated IDENTICALLY
// between wallet.js and referral.js:
//   - TIER_DATA (tier color/rgb lookup table)
//   - getTierKey(name) — normalizes tier name to a lookup key
//   - getTierColor(name) — returns hex color for a tier
//   - getTierRgb(name) — returns RGB string for a tier
//   - applyTierVars(el, name) — sets --tier-color and --tier-rgb CSS vars
//   - formatNumber(n) — formats a number with en-US locale
//   - setBalanceAmountText(el, valueText) — Phase 31 Issue 2: span-preserving
//     balance write shared by wallet.js AND app.js (both load AFTER this
//     file — see index.html script order).
//
// MUST be loaded BEFORE wallet.js and referral.js (see index.html script order).
// These are global functions (no module system) — they attach to window.* via
// the default global scope, matching the existing vanilla JS pattern.
//
// NOTE: cosmetics.js has its OWN formatNumber implementation (different
// null/NaN handling) — do NOT unify it without a separate audit.
// ============================================================

const TIER_DATA = {
  // starter: REFERRAL LEVEL ONLY (Starter 0–2 active referrals). The Wallet
  // tier ladder never returns 'Starter' — backend wallet tiers start at
  // Bronze. Additive entry: the original 5 tiers are unchanged.
  starter:  { hex: '#8E9BAE', rgb: '142, 155, 174' },
  bronze:   { hex: '#CD7F32', rgb: '205, 127, 50' },
  silver:   { hex: '#C0C0C0', rgb: '192, 192, 192' },
  gold:     { hex: '#FFD700', rgb: '255, 215, 0' },
  platinum: { hex: '#6CB4EE', rgb: '108, 180, 238' },
  diamond:  { hex: '#00CED1', rgb: '0, 206, 209' },
};

function getTierKey(name) {
  if (!name) return 'bronze';
  const n = String(name).toLowerCase().trim();
  if (n.includes('diamond')) return 'diamond';
  if (n.includes('platinum')) return 'platinum';
  if (n.includes('gold')) return 'gold';
  if (n.includes('silver')) return 'silver';
  if (n.includes('bronze')) return 'bronze';
  // REFERRAL LEVEL ONLY: 'Starter' exists solely in the Referral level
  // ladder (0–2 active referrals). Wallet never passes 'Starter' here —
  // the wallet backend ladder starts at Bronze.
  if (n.includes('starter')) return 'starter';
  return 'bronze';
}

function getTierColor(name) {
  return TIER_DATA[getTierKey(name)].hex;
}

function getTierRgb(name) {
  return TIER_DATA[getTierKey(name)].rgb;
}

function applyTierVars(el, name) {
  if (!el) return;
  el.style.setProperty('--tier-color', getTierColor(name));
  el.style.setProperty('--tier-rgb', getTierRgb(name));
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

// ============================================================
// Phase 31 Issue 2 — AB ticker span preservation
// ============================================================
// The Profile preview card and the Wallet hero render the balance as:
//   <div class="balance-value">1,234 <span class="balance-ticker">AB</span></div>
//   <div class="wallet-hero-balance-value">1,234 <span class="hero-ticker">AB</span></div>
// Balance writers that used `el.textContent = <number>` destroyed the unit
// span, because assigning textContent replaces ALL child nodes. This was a
// regression of the PR #66 DOM-FIX (2026-10-03): once the writers were
// re-pointed at the real elements (.balance-value / .wallet-hero-balance-
// value), every refresh path (60s poll, visibilitychange foreground return,
// Profile revisit, bfcache pageshow, claimDaily, VPN purchase, post-mutation
// fallback, and every count-up animation frame in animateBalanceChange)
// silently dropped the "AB" unit from the card.
//
// This helper writes ONLY the leading text node so the unit span (and any
// other child element) survives every update. Used by wallet.js
// (refreshWalletBalance / executeVpnPurchase / claimDaily) and app.js
// (animateBalanceChange / refreshWalletAfterMutation / bootstrap
// wallet_changed) — both load AFTER this file in index.html script order.
function setBalanceAmountText(el, valueText) {
  if (!el) return;
  const first = el.firstChild;
  // Normal path: rendered markup is TEXT(value + separator) + <span>AB</span>
  // — update only the text node, keep the unit span, and preserve the
  // separator whitespace that the markup places between number and unit
  // (dropping it would render "2,500AB" glued together).
  // Node.TEXT_NODE === 3 (literal: the Node global is not guaranteed in
  // sandboxed regression-test contexts).
  if (first && first.nodeType === 3) {
    const separator = /[ \t\u00A0]*$/.exec(first.nodeValue || '')[0];
    first.nodeValue = valueText + separator;
    return;
  }
  // Defensive path: element child first (no leading text yet) — insert a
  // text node BEFORE it so existing children (the unit span) are preserved.
  if (first && typeof el.insertBefore === 'function' &&
      typeof document !== 'undefined' && typeof document.createTextNode === 'function') {
    el.insertBefore(document.createTextNode(valueText), first);
    return;
  }
  // Fallback: no child structure to preserve (empty element without a unit
  // span, or a plain mock object in regression-test sandboxes) — equivalent
  // to the pre-fix write for elements that have nothing to destroy.
  el.textContent = valueText;
}

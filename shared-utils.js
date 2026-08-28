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
//
// MUST be loaded BEFORE wallet.js and referral.js (see index.html script order).
// These are global functions (no module system) — they attach to window.* via
// the default global scope, matching the existing vanilla JS pattern.
//
// NOTE: cosmetics.js has its OWN formatNumber implementation (different
// null/NaN handling) — do NOT unify it without a separate audit.
// ============================================================

const TIER_DATA = {
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

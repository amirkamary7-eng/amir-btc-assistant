/**
 * Daily Reward Streak Gap Detection — Regression Test
 *
 * Tests the frontend gap-detection fix in wallet.js:
 *   _renderStreakDaysHTML and _updateDailyCheckinCard must check
 *   last_claim_date against Tehran yesterday before computing
 *   todayDay = streak_day + 1.
 *
 * Scenarios tested:
 *   T1: claimed_today=false + last_claim_date=broken gap → Day 1
 *   T2: claimed_today=false + last_claim_date=yesterday → next streak day
 *   T3: claimed_today=true → current day
 *   T4: Day 7 + yesterday → cycle wrap to Day 1
 *   T5: Premium + broken streak → Day 1 (backend multiplier unchanged)
 *   T6: _renderStreakDaysHTML reads last_claim_date (static)
 *   T7: _updateDailyCheckinCard reads last_claim_date (static)
 *
 * Run: node --test wallet-streak-gap-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');

// ────────────────────────────────────────────────────────────────────────────
// Static tests — verify the source code has the gap-detection logic
// ────────────────────────────────────────────────────────────────────────────

test('T6: _renderStreakDaysHTML consumes last_claim_date for gap detection', () => {
  assert.ok(WALLET_SRC.includes('_feGetTehranYesterdayString'),
    '_feGetTehranYesterdayString helper must exist in wallet.js');
  assert.ok(WALLET_SRC.includes('const _streakAlive = claimedToday || (_lastClaim === _yesterday)'),
    '_renderStreakDaysHTML must compute _streakAlive using last_claim_date');
  assert.ok(WALLET_SRC.includes('const todayDay = _streakAlive'),
    '_renderStreakDaysHTML must gate todayDay on _streakAlive');
});

test('T7: _updateDailyCheckinCard consumes last_claim_date for gap detection', () => {
  // The card function uses `state.last_claim_date` (not _dailyCheckinState)
  assert.ok(WALLET_SRC.includes("const _lastClaim = state.last_claim_date || null;"),
    '_updateDailyCheckinCard must read state.last_claim_date');
  assert.ok(WALLET_SRC.includes('const _streakAlive = _lastClaim === _yesterday'),
    '_updateDailyCheckinCard must compute _streakAlive using last_claim_date');
  assert.ok(WALLET_SRC.includes('const day = _streakAlive'),
    '_updateDailyCheckinCard must gate day on _streakAlive');
});

// ────────────────────────────────────────────────────────────────────────────
// Dynamic tests — simulate the gap-detection logic with mock state
// These mirror the EXACT logic in _renderStreakDaysHTML and _updateDailyCheckinCard
// ────────────────────────────────────────────────────────────────────────────

// Replicate _feGetTehranYesterdayString
function _feGetTehranYesterdayString() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  } catch (_) {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}

// Replicate _feGetTehranDateString
function _feGetTehranDateString() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Replicate the todayDay logic from _renderStreakDaysHTML (with Day 7 wrap)
function computeTodayDay(state) {
  const claimedToday = state.claimed_today;
  const currentStreakDay = state.streak_day;
  const _yesterday = _feGetTehranYesterdayString();
  const _lastClaim = state.last_claim_date || null;
  const _streakAlive = claimedToday || (_lastClaim === _yesterday);
  return _streakAlive
    ? (claimedToday ? currentStreakDay : (currentStreakDay > 0 ? (currentStreakDay % 7) + 1 : 1))
    : 1;
}

// Replicate the day logic from _updateDailyCheckinCard (with Day 7 wrap)
function computeCardDay(state) {
  if (state.claimed_today) return state.streak_day;
  const _yesterday = _feGetTehranYesterdayString();
  const _lastClaim = state.last_claim_date || null;
  const _streakAlive = _lastClaim === _yesterday;
  return _streakAlive
    ? (state.streak_day > 0 ? (state.streak_day % 7) + 1 : 1)
    : 1;
}

const yesterday = _feGetTehranYesterdayString();
const today = _feGetTehranDateString();
const twoDaysAgo = (() => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() - 48 * 60 * 60 * 1000));
  } catch (_) {
    return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
})();

test('T1: claimed_today=false + last_claim_date=broken gap → Day 1', () => {
  const state = {
    streak_day: 2,
    claimed_today: false,
    last_claim_date: twoDaysAgo, // gap > 1 day — streak broken
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 1, 'Broken streak must show Day 1 (not Day 3)');

  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 1, 'Card must show Day 1/7 (not Day 3/7)');
});

test('T2: claimed_today=false + last_claim_date=yesterday → next streak day', () => {
  const state = {
    streak_day: 2,
    claimed_today: false,
    last_claim_date: yesterday, // streak alive
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 3, 'Alive streak must show Day 3 (streak_day=2 + 1)');

  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 3, 'Card must show Day 3/7');
});

test('T3: claimed_today=true → current day', () => {
  const state = {
    streak_day: 2,
    claimed_today: true,
    last_claim_date: today,
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 2, 'Already claimed must show current streak_day (2)');

  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 2, 'Card must show Day 2/7 · ✓');
});

test('T4: Day 7 + yesterday → Day 1 (frontend wrap matches backend)', () => {
  // Day 7 wrap: (7 % 7) + 1 = 1 — matches backend claimDailyRewardWithStreak
  const state = {
    streak_day: 7,
    claimed_today: false,
    last_claim_date: yesterday, // streak alive
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 1, 'Day 7 + alive → Day 1 (wrap: 7%7+1=1)');

  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 1, 'Card must show Day 1/7 (wrap)');
});

test('T4b: Day 6 + yesterday → Day 7 (no wrap)', () => {
  const state = {
    streak_day: 6,
    claimed_today: false,
    last_claim_date: yesterday,
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 7, 'Day 6 + alive → Day 7 (6+1=7, no wrap)');
});

test('T5: Premium + broken streak → Day 1 (backend multiplier unchanged)', () => {
  // Frontend gap detection is INDEPENDENT of premium status.
  // Premium only affects the reward AMOUNT (backend getMissionRewardAmount),
  // not the streak DAY. The frontend must show Day 1 regardless of premium.
  const state = {
    streak_day: 5,
    claimed_today: false,
    last_claim_date: twoDaysAgo, // broken
    is_premium: true, // premium flag (doesn't affect frontend display)
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 1, 'Premium + broken streak must show Day 1');

  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 1, 'Card must show Day 1/7 regardless of premium');
});

test('T5b: Premium + alive streak → next day (premium multiplier is backend-only)', () => {
  const state = {
    streak_day: 3,
    claimed_today: false,
    last_claim_date: yesterday,
    is_premium: true,
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 4, 'Premium + alive streak must show Day 4');
});

test('T1b: null last_claim_date + claimed_today=false → Day 1', () => {
  const state = {
    streak_day: 0,
    claimed_today: false,
    last_claim_date: null, // never claimed
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 1, 'Never claimed must show Day 1');
});

test('T1c: streak_day=0 + claimed_today=false + last_claim_date=null → Day 1', () => {
  const state = {
    streak_day: 0,
    claimed_today: false,
    last_claim_date: null,
  };
  const cardDay = computeCardDay(state);
  assert.equal(cardDay, 1, 'Card must show Day 1/7 for new user');
});

test('T2b: streak_day=1 + yesterday → Day 2', () => {
  const state = {
    streak_day: 1,
    claimed_today: false,
    last_claim_date: yesterday,
  };
  const todayDay = computeTodayDay(state);
  assert.equal(todayDay, 2, 'Day 1 claimed yesterday → Day 2 available today');
});

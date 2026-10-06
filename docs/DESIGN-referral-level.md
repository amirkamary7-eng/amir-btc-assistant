# Referral Level — Approved Product Design (NOT YET IMPLEMENTED)

> **STATUS: DESIGN ONLY.** This document records the user-approved product
> decision for the future Referral Level system. **No code implements this
> yet.** Implementation is deferred to a later phase and must start with
> explicit user approval.

## Decision (approved by product owner)

Referral gets its own Level system, fully independent from the Wallet tier
(Bronze/Silver/Gold/Diamond by AB balance) and from Membership
(FREE/VIP/PREMIUM/ELITE).

### Ladder — final

| Level | Successful referrals |
|---|---|
| Starter | 0 – 2 |
| Bronze | 3 – 9 |
| Silver | 10 – 24 |
| Gold | 25 – 49 |
| Platinum | 50 – 99 |
| Diamond | 100+ |

- Counting basis: **total successful referrals**.
- **Starter IS displayed** (not hidden behind Bronze).
- Platinum exists ONLY in the Referral ladder. The Wallet ladder stays
  4-tier (Bronze/Silver/Gold/Diamond by AB balance) — the two ladders are
  intentionally different systems and must never share a source.

### Known thresholds that exist in the codebase today (audit findings)

1. Frontend referral achievement badges (`referral.js` `computeAchievements`):
   bronze=3, silver=10, gold=25, platinum=50, diamond=100 invites — matches
   the approved ladder for the badge levels; Starter (0–2) is new.
2. DB table `referral_reward_tiers` (seed in `src/repositories/reward_center.js`):
   invite milestones 1/5/10/25/50/100 → token bonuses + spins. **These are
   REWARD milestones, not levels.** Only the `invite_count <= 1` row is
   consumed today (base per-invite reward); the milestone payout function
   promised in the JSDoc (`getRewardForInviteCount`) does not exist — a dead
   ladder that must be decided separately (out of scope for this design).
3. The Referral page "League" currently displays the **Wallet tier** from
   `/api/wallet/summary` (`referral.js` `fetchWalletSummary`) — this is the
   bug this design replaces: `summary.tier` must never be shown as the
   Referral level again.

### Implementation notes for the future phase (sketch, not code)

- Source of truth: backend `getReferralTierForCount(count)` in the referrals
  repository (runtime-computed, like the wallet's `getTierForBalance` —
  no DB storage, no server cache).
- API: `/api/referrals/stats` gains a `referral_tier` field
  (current/next/progress/remaining built from the ladder above).
- Frontend: `referral.js` hero League reads `stats.referral_tier`;
  `fetchWalletSummary` remains only for the balance display.
- The 5-tier color palette in `shared-utils.js` (TIER_DATA, includes
  platinum) already covers the visual needs — no palette change needed.
- i18n: needs a `Starter` label key (fa + en) in both dictionaries.

## Related (separate, already shipped)

Phase 1 + Phase 2 of the Level-system fix (Wallet visual tier + tier
freshness) live in `wallet.css`, `wallet.js`, `src/repositories/wallet.js`,
`src/controllers/*` — see the wallet tier regression tests for coverage.

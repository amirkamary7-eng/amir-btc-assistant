# Membership Rebuild — Worklog / Checkpoint

## Session: 2026-08-15 — Phase A (Current State Audit + Safe GitHub Baseline)

### What Happened
Previous Membership Phase 0–6 work (8 commits, ~10,000 lines) was lost due to an
environment/repository mismatch. The work existed only in a previous sandbox
environment that was reset or re-provisioned. No commits, files, branches, tags,
or git objects from that work were recoverable.

### Current Baseline (This Environment)
```
Repository:     /home/z/my-project/amir-btc-assistant
HEAD:           ccfa22914321e3d4fbf36eb2c61ac689db5e26e8
Branch:         membership/rebuild-phase0-6 (checked out from main)
origin/main:    1382435c9f89e721e9c6462fcf1c17f3232ecb58 (UNCHANGED)
```

### GitHub Safety Checkpoints (PUSHED)
```
Backup branch:  backup/pre-membership-rebuild-2026-08-15  → ccfa229
Backup tag:     pre-membership-rebuild-2026-08-15          → ccfa229
Rebuild branch: membership/rebuild-phase0-6                → ccfa229
```

All three point to the SAME commit (ccfa229). origin/main is UNCHANGED.

### Baseline Test Results
```
14 test suites:  356 PASS / 0 FAIL / 0 SKIPPED
```

### What EXISTS (pre-existing, from prior non-membership work)
- Membership controller (809 lines) — state machine, admin actions, audit logs
- Membership repository (431 lines) — CRUD for users, requests, audit logs
- Membership schema (membership-schema.sql) — 5 tables: membership_users, membership_requests, membership_audit_logs, membership_admins, exchange_campaigns
- 21 membership API endpoints (user + admin)
- Alert economy (alert_config, alert_quota) — quota + token extension for alerts
- Economy service (grantReward, debitUser) — central token economy
- Wallet repo (708 lines) — creditTokens, debitTokens, claimDailyReward
- Frontend: membership-user.js (612 lines), membership-admin.js (283 lines)

### What's MISSING (must be rebuilt for Phase 0–6)
- Phase 0: MembershipAuthority (src/services/membership_authority.js) — NOT EXISTS
- Phase 1: Rules + Acceptance (membership_rules, membership_rule_acceptances tables) — NOT EXISTS
- Phase 2: Requirements (membership_requirements table, data-driven exchange) — NOT EXISTS
- Phase 3: Entitlement config (src/services/entitlement_config.js) — NOT EXISTS
- Phase 3: KV TTL fix (MIN_KV_TTL in writeRateLimitCache) — NOT EXISTS
- Phase 3: Tier-based quotas (alerts 3→10, AI 50→100, wheel 3→5, watchlist 7→20) — NOT EXISTS
- Phase 4: Tier-based rewards (daily 10→20, missions 1×→1.5×, referral 3→6) — NOT EXISTS
- Phase 5: Cosmetics (profile_cosmetics, user_cosmetic_ownership tables, repo, controller, frontend) — NOT EXISTS
- Phase 6: Premium UI (💎 PREMIUM badge, VIP popup quotas, activation popup preview) — NOT EXISTS

### Implementation Plan
The rebuild will follow the same 7-phase plan (0–6) as before. The design docs
and full file contents are available in the conversation history and can be
reconstructed. Each phase will be committed to membership/rebuild-phase0-6
and pushed to GitHub immediately after verification.

### Next Step
PHASE 0 IMPLEMENTATION ONLY — awaiting explicit authorization.

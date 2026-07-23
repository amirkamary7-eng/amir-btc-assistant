# Production Referral E2E Test — Manual Execution Plan

> **Purpose:** Prove the Referral system works end-to-end on **real Production**
> (Neon DB + Cloudflare Worker + real Telegram accounts).
>
> **NOT** pg-mem. **NOT** mock. **NOT** local.

---

## PREREQUISITES (you need these — I do not have them)

| # | Item | How to get it |
|---|------|---------------|
| 1 | **Neon Production `DATABASE_URL`** | Cloudflare Dashboard → Workers & Pages → `amir-btc-assistant-api-production` → Settings → Variables and Secrets → `DATABASE_URL` (reveal). OR: Neon Dashboard → your project → Connection Details → connection string. |
| 2 | **Cloudflare API Token** (for `wrangler tail`) | `npx wrangler login` (browser flow), OR create a token at https://dash.cloudflare.com/profile/api-tokens |
| 3 | **Two real Telegram accounts** on two phones (or phone + desktop) | Account A = inviter, Account B = invitee |
| 4 | **Both accounts must NOT be in each other's referral history** | Use fresh accounts if possible. If B already bootstrapped before, the referral will be rejected as "NOT-new-user". |

---

## STEP 0 — Start the live log monitor (Terminal 1)

```bash
cd /home/z/amir-btc-assistant
npx wrangler login          # only if not already logged in
./scripts/monitor-referral-logs.sh
```

You should see: `✅ Connected to ...` and a live tail prompt.
**Leave this running.** Every referral event will appear here in real time.

---

## STEP 1 — Account A: Open Mini App and get referral link

1. On **Phone A**, open Telegram.
2. Open the bot: **@Amir_BTC_AssistantBot**
3. Tap **Start** (or the menu button → open Mini App).
4. The Mini App dashboard loads.
5. Go to the **Referral** tab (or Profile → Invite Friends).
6. Tap **"دعوت از دوستان"** / **"Copy Referral Link"**.
7. The link looks like:
   ```
   https://t.me/Amir_BTC_AssistantBot?startapp=ref_100000001
   ```
   where `100000001` is Account A's real Telegram ID.
8. **Write down Account A's Telegram ID** — you'll need it for DB verification.

> ✅ **Checkpoint:** Account A's Telegram ID is now known. Note it: `A_ID = ___________`

---

## STEP 2 — Account B: Open the referral link

1. Send the referral link from Step 1 to **Account B** (via Saved Messages, another chat, etc.).
2. On **Phone B**, open Telegram.
3. Tap the link → it opens the bot with `?startapp=ref_<A_ID>`.
4. Tap **Start** → the Mini App opens.
5. The frontend (`app.js` → `getReferrerId()`) extracts `ref_<A_ID>` from `startapp`.
6. `bootstrapUser()` sends `POST /api/users/bootstrap` with body:
   ```json
   {
     "user_id": "<B_ID>",
     "referrer_id": "<A_ID>",
     "username": "...",
     "first_name": "...",
     "lang": "fa"
   }
   ```
7. The Worker (`handleBootstrap`) detects `isNewUser = true`, calls `processReferralOnBootstrap`.

> ✅ **Checkpoint (Terminal 1 — logs):** You should see these log lines appear:
> ```
> diag-handleBootstrap { userId: "<B_ID>", referrer_id: "<A_ID>", isNewUser: true }
> diag-processReferralOnBootstrap { inviteeId: "<B_ID>", referrerId: "<A_ID>", channelJoined: false, isNewUser: true }
> diag-processReferralOnBootstrap-INSERT { createdReferral: { id: <N>, rewarded: false }, rowCount: 1 }
> ```
> If you see `diag-processReferralOnBootstrap-REJECTED { reason: "NOT-new-user" }` → Account B already existed. Use a fresh account.

> **Write down Account B's Telegram ID:** `B_ID = ___________`

---

## STEP 3 — Account B: Join the required channel

1. The Mini App shows a **channel join gate** (lock screen).
2. Tap the **"Join Channel"** button → redirects to `https://t.me/amir_btc_2024`.
3. In Telegram, tap **Join**.
4. Return to the Mini App (Telegram → back to bot → Mini App button, or just reopen).
5. The Mini App re-checks membership. On success:
   - `users.channel_joined = TRUE` for B
   - `processPendingReferralReward(B, channelJoined=true)` fires
   - This credits tokens to A and creates the transaction.

> ✅ **Checkpoint (Terminal 1 — logs):** You should see:
> ```
> diag-processReferralOnBootstrap-calling-reward { referral_id: <N>, channelJoined: true }
> diag-creditReferralWithReward { inviterId: "<A_ID>", referralId: <N>, inviteeId: "<B_ID>", amount: 3 }
> diag-creditReferralWithReward-SUCCESS
> ```
> If you see `diag-creditReferralWithReward-ERROR` → something went wrong in the transaction. Capture the full error.

---

## STEP 4 — Verify on Production Database (Terminal 2)

```bash
cd /home/z/amir-btc-assistant

# Paste your REAL Neon DATABASE_URL here:
export DATABASE_URL='postgresql://USER:PASS@ep-HOST.neon.tech/DB?pgbouncer=true'

# Run the verification script with both IDs:
node scripts/verify-production-referral.cjs --inviter <A_ID> --invitee <B_ID>
```

### Expected output (if referral worked):

```
── users (2 rows) ────────────────────────────────────────────────────
   telegram_id | username    | first_name | channel_joined | ...
   ------------+-------------+------------+----------------+-----
   <A_ID>      | alice       | Alice      | t              | ...
   <B_ID>      | bob         | Bob        | t              | ...

── referrals (1 rows) ────────────────────────────────────────────────
   id | inviter_id | invitee_id | channel_verified | rewarded | created_at
   ---+------------+------------+------------------+----------+-----------
   <N>| <A_ID>     | <B_ID>     | t                | t        | 2026-...

── token_balances (1 rows) ───────────────────────────────────────────
   user_id  | balance | updated_at
   ---------+---------+----------
   <A_ID>   | 3       | 2026-...

── token_transactions (1 rows) ───────────────────────────────────────
   id | user_id  | amount | tx_type          | description                    | ref_id | created_at
   ---+----------+--------+------------------+--------------------------------+--------+-----------
   <M>| <A_ID>   | 3      | referral_reward  | Invite reward for user <B_ID>  | <N>    | 2026-...

══════════════════════════════════════════════════════════════════════
  VERDICT
══════════════════════════════════════════════════════════════════════
  Referral row exists:        ✅ YES
  channel_verified = true:    ✅ YES
  rewarded = true:            ✅ YES
  Inviter token balance > 0:  ✅ YES (3)
  referral_reward tx exists:  ✅ YES

  🎉 REFERRAL FLOW VERIFIED ON PRODUCTION DATABASE
```

---

## STEP 5 — Collect proof artifacts

Save these three things as evidence:

```bash
# 1. The log output from Terminal 1 (while the test ran)
#    Select all log lines containing diag-* and copy them to a file:
#    (do this in your terminal — select + copy)

# 2. The DB verification output from Terminal 2:
node scripts/verify-production-referral.cjs --inviter <A_ID> --invitee <B_ID> \
  > referral-proof-$(date +%Y%m%d-%H%M%S).txt 2>&1

# 3. The git commit of the code under test:
git rev-parse HEAD > referral-proof-commit.txt
```

---

## TROUBLESHOOTING

### Problem: `diag-processReferralOnBootstrap-REJECTED { reason: "NOT-new-user" }`
**Cause:** Account B had already bootstrapped before (exists in `users` table).
**Fix:** Use a completely fresh Telegram account that has never opened this Mini App.

### Problem: `diag-processReferralOnBootstrap-REJECTED { reason: "inviter-not-found" }`
**Cause:** Account A doesn't exist in the `users` table (never bootstrapped).
**Fix:** Account A must open the Mini App at least once before its ID can be a referrer.

### Problem: `diag-processReferralOnBootstrap-REJECTED { reason: "M-R4-invalid-or-self" }`
**Cause:** The `referrer_id` is not numeric, or B is trying to refer itself.
**Fix:** Check the referral link format: `?startapp=ref_<digits only>`.

### Problem: No `diag-creditReferralWithReward` log appears after channel join
**Cause:** `processPendingReferralReward` only fires when `channelJoined = true`. The channel membership check may have failed.
**Fix:** Check the log for `resolveChannelMembership` errors. Account B may not have actually joined `amir_btc_2024`.

### Problem: `diag-creditReferralWithReward-ERROR`
**Cause:** The 3-query transaction (balance upsert + tx insert + referral update) failed.
**Fix:** Capture the full error stack from logs. Most likely a schema issue or constraint violation.

---

## FINAL CHECKLIST — only mark complete with REAL evidence

| # | Check | Evidence required |
|---|-------|-------------------|
| 1 | Account B entered via referral link | Screenshot of `?startapp=ref_<A_ID>` URL in Telegram |
| 2 | `referrals` row created | DB dump showing row with `inviter_id=A_ID, invitee_id=B_ID` |
| 3 | `token_balances` increased for A | DB dump showing `balance=3` (or higher) for A |
| 4 | `token_transactions` row created | DB dump showing `tx_type=referral_reward, amount=3, ref_id=<referral_id>` |
| 5 | Worker logs show the flow | Log lines: `diag-handleBootstrap` → `diag-processReferralOnBootstrap-INSERT` → `diag-creditReferralWithReward-SUCCESS` |
| 6 | All on Neon Production (not pg-mem) | `DATABASE_URL` contains `neon.tech` |

**Only when all 6 boxes have real evidence → Referral system is 100% confirmed on Production.**

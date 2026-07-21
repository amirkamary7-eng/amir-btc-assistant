#!/usr/bin/env bash
#
# PRODUCTION WORKER LOG MONITOR — Referral Flow
#
# Streams real-time Cloudflare Worker logs filtered to referral events.
# Run this in ONE terminal, then perform the Telegram test in another.
#
# PREREQUISITES:
#   1. You must be logged into wrangler:
#        npx wrangler login
#   2. (Optional) Set CLOUDFLARE_API_TOKEN to skip login.
#
# USAGE:
#   ./scripts/monitor-referral-logs.sh
#
# WHAT YOU'LL SEE:
#   Every /api/users/bootstrap call, referral creation, and reward processing
#   with real timestamps — proving the Worker executed the flow.
#
set -euo pipefail

cd "$(dirname "$0")/.."

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  LIVE WORKER LOG MONITOR — Referral Flow                         ║"
echo "║  Press Ctrl+C to stop                                            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Watching for these log lines (from worker-proxy.js + controllers):"
echo "    • diag-handleBootstrap"
echo "    • diag-processReferralOnBootstrap"
echo "    • diag-processReferralOnBootstrap-INSERT"
echo "    • diag-creditReferralWithReward"
echo "    • diag-creditReferralWithReward-SUCCESS"
echo "    • bootstrap-user"
echo "    • referral-reward-failed  (only if something broke)"
echo ""
echo "  Now perform the Telegram test on your phone:"
echo "    1. Account A opens Mini App, copies referral link"
echo "    2. Account B opens the link, joins channel"
echo ""
echo "  ─────────────────────────────────────────────────────────────────"
echo ""

# Use wrangler tail on production environment.
# --format=pretty gives human-readable output with timestamps.
npx wrangler tail amir-btc-assistant-api-production \
  --env production \
  --format pretty \
  --status error,ok \
  2>&1 | grep --line-buffered -iE \
    'bootstrap|referral|creditReferral|processReferral|reward|token_balance|token_transaction|TG-AUTH|error|exception' \
  || {
    echo ""
    echo "❌ wrangler tail failed. Common causes:"
    echo "   1. Not logged in → run: npx wrangler login"
    echo "   2. Wrong worker name → check: npx wrangler deploy --dry-run --env production"
    echo "   3. No CLOUDFLARE_API_TOKEN → set it: export CLOUDFLARE_API_TOKEN=xxxxx"
    exit 1
  }

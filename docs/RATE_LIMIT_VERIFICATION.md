# Rate Limit Verification Runbook (Production)

How to correctly verify the public market rate limit in production — and the
measurement pitfall that caused the Task 67 false alarm ("145+ requests, zero
429s"). Written during the Task 68 root-cause audit; evidence and commands
below were run against production on 2026-10-11.

## TL;DR

- The public market rate limit **works in production exactly as designed**:
  30 requests / 60 s per `(telegram user id | anon, client IP)` key.
- The Task 67 "145+ requests without 429" observation was a **test artifact**:
  the audit machine's outbound traffic egresses through a **rotating pool of
  IPs**. Every new TCP connection may arrive at the Worker with a different
  `cf-connecting-ip`, so every request was a *different anonymous client* with
  its own fresh 30/60s bucket — correctly allowed.
- To test the limiter you MUST keep the client identity stable: send the
  burst over **one connection** (see methodology below).

## What the limiter is (architecture reference)

Two layers, consulted in this order, guarding the 4 public market endpoints
(`/api/market`, `/api/market/overview`, `/api/forex`, `/api/market/search`):

1. **`MARKET_RATE_LIMITER` binding** (wrangler.jsonc `ratelimits`,
   `simple {limit: 30, period: 60}`; namespace 731001 staging / 731002
   production — added in #77, fixed in #78). Per-datacenter counter shared by
   every isolate; a block is an early 429 with zero KV operations. Failures
   degrade to layer 2 (`console.warn` only).
2. **KV sliding window** (`RATE_LIMITS` namespace, key `mrl:<uid>:<ip>`,
   `MARKET_RATE_LIMIT_MAX = 30`, window 60 s, F-03 linear carry from the
   previous window). In-isolate in-memory delta coalesces writes; the block
   decision is read-only; KV write failures retain the delta so the isolate
   still self-limits.

The check runs BEFORE the KV market-cache read, `singleFlight`, and any
upstream price fetch — a 429 never triggers external API calls. The key uses
`cf-connecting-ip`, which is set by the Cloudflare edge and **cannot be
forged by clients** on `*.workers.dev`; other IP headers are ignored.

## Known tolerance bounds (by design — do not file bugs for these)

- **Cross-isolate overshoot (KV layer only, binding absent/erroring):**
  N isolates → worst case N×30 in one window (2 isolates → 60). Reproduced
  and pinned in `tests/market-rate-limit-multi-isolate-test.cjs`
  (S4-REPRO: 38, S4-WORST: 60). The binding exists precisely to close this
  per-datacenter.
- **±1 at the concurrent boundary:** concurrent requests that all read the
  same count before any flush can let one extra through (documented RMW race,
  see `worker-proxy.js` CROSS-ISOLATE CORRECTNESS note). Observed live:
  40 concurrent → 31 allowed.
- **Per-IP keying:** clients rotating their IP (VPN, proxies — or a test
  machine with rotating egress) legitimately get a fresh bucket per IP. This
  is the documented keying trade-off (per-IP fairness vs NAT sharing; the
  uid is included in the key when initData is present).

## Correct verification methodology

### 0. Check what a "client" is from your machine first

The audit sandbox egresses through a rotating IP pool (observed:
`47.57.232.232`, `47.57.242.119`, `8.212.10.159` across 6 separate
connections, same colo HKG). Verify your own situation:

```bash
for i in 1 2 3 4 5 6; do
  curl -s https://amir-btc-assistant-api-production.amirkamari9939.workers.dev/cdn-cgi/trace | grep '^ip='
done
# Rotating IPs across processes ⇒ single curls CANNOT test the limiter.
```

Within ONE connection the IP is stable (HTTP/2 reuse) — that is the basis of
the methodology below.

### 1. Sequential burst over one connection (curl config file)

```bash
CFG=$(mktemp)
for i in $(seq 1 40); do
  printf 'url = "https://amir-btc-assistant-api-production.amirkamari9939.workers.dev/api/market"\noutput = "/dev/null"\nwrite-out = "%%{http_code}\\n"\n' >> "$CFG"
done
curl -s --max-time 120 --config "$CFG" | uniq -c
```

Expected: exactly `30 200` then `10 429` (verified twice on 2026-10-11:
40→30/10 and 35→30/5). The 429 body is
`{"status":"error","message":"Rate limited"}` with `cache-control: no-store`.

### 2. Concurrency over one HTTP/2 connection (Node)

```bash
node -e '
const http2 = require("node:http2");
const N = 40;
const s = http2.connect("https://amir-btc-assistant-api-production.amirkamari9939.workers.dev");
const fire = () => new Promise((res) => {
  const r = s.request({ ":method": "GET", ":path": "/api/market" });
  let st = 0;
  r.on("response", (h) => { st = h[":status"]; });
  r.on("error", () => res("ERR"));
  r.on("close", () => res(st || "NO_STATUS"));
  r.resume(); // drain body — otherwise HTTP/2 flow control stalls the stream
  r.end();
});
(async () => {
  const counts = {};
  (await Promise.all(Array.from({ length: N }, fire)))
    .forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
  console.log(JSON.stringify(counts));
  s.close();
})();'
```

Expected: ~30×200 + ~10×429 (observed: 31×200 + 9×429 — one over from the
documented boundary race). All-200s would indicate a real problem.

### 3. Window recovery

Wait ≥ 60 s after the burst, then a single request must return 200
(observed: 200 after 70 s).

## Safety rules for running this against production

- Keep bursts ≤ ~40 requests and let the window recover between runs; the
  endpoints are cheap (limiter → KV cache hit), but do not stress-test.
- Run at most a few bursts per hour; each burst consumes one full
  30/60s bucket for your (uid, IP).
- Never authenticate with a real user account while testing (an authenticated
  key is per user+IP).
- The staging worker is NOT guaranteed current (its deploy fails at the
  schedules API step — pre-existing, see worklog Task 67); verify rate
  limiting on production only.

## What still requires Cloudflare access (not externally observable)

- Attributing enforcement to the binding vs a single warm isolate (both
  produce "exactly 30" under sequential load). Use `wrangler tail` /
  Workers observability logs (console.warn "market rate-limit binding
  failed" would indicate binding-layer errors) and the dashboard's rate
  limiter namespace (731002) metrics.
- KV error rates, daily write quota headroom, per-isolate distribution.

## History

- #77 (3f725419): added the binding gate + config (F-03/S4); namespace_ids
  initially non-numeric → production deploy failed with CF error 10021.
- #78 (39f4369c): fixed namespace_ids (731001/731002) → deploys green.
- Task 67 (2026-10-11): post-merge verification reported "no 429 under 145+
  requests" — measurement artifact (rotating egress IPs), limiter fine.
- Task 68 (2026-10-11): this runbook; root-caused and re-verified with
  stable-identity bursts (30/10, 30/5, 31/9, recovery 200).

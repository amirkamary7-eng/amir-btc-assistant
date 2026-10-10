/**
 * MK-04 — /api/market/price dedicated per-user rate limit (30/min)
 * ==============================================================
 *
 * Task 62 finding MK-04: GET /api/market/price was auth-gated (401 for anon)
 * but had NO rate limit. Each call invokes fetchSpotPriceUsd — on cache miss
 * that fans out to up to 3 upstream exchanges (bybit/okx/mexc) — so a runaway
 * or scripted client could generate unbounded upstream subrequests (Workers
 * Free plan budget risk). Real consumers: only the background fetch when a
 * non-Top-200 coin detail opens (1 request per open; fast browsing ≈ 6-12/min).
 *
 * FIX (mirrors the sibling /api/market/prices pattern):
 *   isUserRateLimited(env, user.id, 'market-price', 30, 60) — placed AFTER
 *   auth, BEFORE symbol validation; 429 {'Rate limited'}. 30/min = 2.5-5× the
 *   real consumer's usage. DEDICATED bucket (not the public IP bucket, not
 *   the batch 'market-prices' bucket). Fails open on KV outage. The alert
 *   cron and internal paths call fetchSpotPriceUsd directly and never route
 *   through this HTTP endpoint — unaffected (pinned).
 *
 * This test extracts the REAL route block from worker-proxy.js with full
 * dependency injection and exercises the limiter semantics.
 *
 * Pre-fix: S1 FAIL (31st request not limited) and S3 FAIL (no bucket call).
 *
 * Run: node --test tests/mk04-market-price-rate-limit-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Extract the REAL /api/market/price route block
// ============================================================================
function extractRouteBlock() {
  const lines = WORKER_SRC.split('\n');
  let startIdx = -1, endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("url.pathname === '/api/market/price'")) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('route start not found');
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '      }' &&
        lines.slice(j + 1, j + 4).some(l => l.includes('Batch price fetch'))) {
      endIdx = j; break;
    }
  }
  if (endIdx === -1) throw new Error('route end not found');
  return lines.slice(startIdx, endIdx + 1).join('\n');
}
const ROUTE_BLOCK = extractRouteBlock();

// ============================================================================
// Sandbox with full dependency injection
// ============================================================================
function createSandbox(opts = {}) {
  const limiterCalls = [];
  const jsonResponseCalls = [];

  // Configurable limiter: real sliding-window semantics over a Map when
  // 'enforce' is set; otherwise always-allow (pre-fix behavior probe).
  const buckets = new Map();
  const isUserRateLimited = opts.limiter
    ? async (env, userId, category, max, windowSec) => {
        limiterCalls.push({ userId, category, max, windowSec });
        if (opts.limiterFailOpen) return false;
        const key = `${category}:${userId}`;
        const now = Date.now();
        const win = windowSec * 1000;
        const arr = (buckets.get(key) || []).filter(ts => now - ts < win);
        if (arr.length >= max) { buckets.set(key, arr); return true; }
        arr.push(now);
        buckets.set(key, arr);
        return false;
      }
    : async () => false; // pre-fix probe: endpoint had NO limiter call at all

  const authOk = opts.authFail !== true;
  const wrapper = [
    'const authenticateTelegramRequest = __g.authenticateTelegramRequest;',
    'const isUserRateLimited = __g.isUserRateLimited;',
    'const jsonResponse = __g.jsonResponse;',
    'const fetchSpotPriceUsd = __g.fetchSpotPriceUsd;',
    'async function __route(request, url, env) {',
    ROUTE_BLOCK,
    '}',
    'return __route;',
  ].join('\n');

  const route = new Function('__g', wrapper)({
    authenticateTelegramRequest: async () =>
      authOk ? { user: { id: '700200' } } : { error: { __resp: true, status: 401, body: {} } },
    isUserRateLimited,
    jsonResponse: (body, init) => {
      jsonResponseCalls.push({ status: init?.status ?? 200, body });
      return { __resp: true, status: init?.status ?? 200, body };
    },
    fetchSpotPriceUsd: async () =>
      opts.noPrice ? { price: 0 } : { price: 62000.5, exchange: 'bybit', cached: false },
  });

  return { route, limiterCalls, jsonResponseCalls, buckets };
}

const mkReq = () => ({ method: 'GET', headers: {} });
const mkUrl = (symbol) => new URL(`https://worker.local/api/market/price${symbol ? `?symbol=${symbol}` : ''}`);
const mkEnv = () => ({});

// ============================================================================
// Scenarios
// ============================================================================
test('MK-04 S1: 31st request within the 60s window is limited with 429 (30/min cap)', async () => {
  const sb = createSandbox({ limiter: true });
  let last;
  for (let i = 1; i <= 31; i++) {
    last = await sb.route(mkReq(), mkUrl('ETH'), mkEnv());
  }
  assert.equal(last.status, 429, 'request #31 must be rate limited');
  assert.equal(last.body.message, 'Rate limited');
});

test('MK-04 S2: valid request below the limit returns the fresh price (behavior preserved)', async () => {
  const sb = createSandbox({ limiter: true });
  const res = await sb.route(mkReq(), mkUrl('ETH'), mkEnv());
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.symbol, 'ETH');
  assert.equal(res.body.price, 62000.5);
  assert.equal(res.body.exchange, 'bybit');
  assert.ok(Number.isFinite(res.body.timestamp));
});

test('MK-04 S3: limiter uses the DEDICATED market-price bucket (30 req / 60 s), after auth', async () => {
  const sb = createSandbox({ limiter: true });
  await sb.route(mkReq(), mkUrl('ETH'), mkEnv());
  assert.equal(sb.limiterCalls.length, 1, 'exactly one limiter call per request');
  assert.equal(sb.limiterCalls[0].category, 'market-price', 'dedicated bucket');
  assert.equal(sb.limiterCalls[0].max, 30, '30 requests');
  assert.equal(sb.limiterCalls[0].windowSec, 60, 'per 60 seconds');
  assert.equal(sb.limiterCalls[0].userId, '700200', 'per authenticated user');
});

test('MK-04 S4: pre-existing 422 missing-symbol validation preserved (after the limiter)', async () => {
  const sb = createSandbox({ limiter: true });
  const res = await sb.route(mkReq(), mkUrl(''), mkEnv());
  assert.equal(res.status, 422);
  assert.equal(res.body.message, 'Missing symbol');
  // The limiter ran BEFORE validation (sibling ordering with /api/market/prices)
  assert.equal(sb.limiterCalls.length, 1, 'limiter runs before validation');
});

test('MK-04 S5: auth failure returns 401 and never consumes the rate-limit bucket', async () => {
  const sb = createSandbox({ limiter: true, authFail: true });
  const res = await sb.route(mkReq(), mkUrl('ETH'), mkEnv());
  assert.equal(res.status, 401);
  assert.equal(sb.limiterCalls.length, 0, 'auth gate precedes the limiter — no bucket consumption');
});

test('MK-04 S6: KV outage fails OPEN (endpoint stays available); cron/internal paths never hit this route', async () => {
  const sb = createSandbox({ limiter: true, limiterFailOpen: true });
  for (let i = 0; i < 50; i++) {
    const res = await sb.route(mkReq(), mkUrl('ETH'), mkEnv());
    assert.equal(res.status, 200, 'KV outage must degrade the limit, not the endpoint');
  }
  // Source pin: the scheduled alert evaluation fetches via fetchSpotPriceUsd
  // directly — the HTTP route is never used internally. Extract ONLY the cron
  // function (brace-counted) to avoid swallowing the HTTP route section.
  const allLines = WORKER_SRC.split('\n');
  const cronStart = allLines.findIndex(l => l.startsWith('async function runScheduledAlertsBaseline'));
  assert.ok(cronStart !== -1, 'runScheduledAlertsBaseline must exist');
  let depth = 0, cronEnd = -1;
  for (let i = cronStart; i < allLines.length; i++) {
    for (const ch of allLines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0 && i > cronStart) { cronEnd = i; break; }
  }
  assert.ok(cronEnd !== -1, 'cron function end must be found');
  const cronZone = allLines.slice(cronStart, cronEnd + 1).join('\n');
  assert.ok(cronZone.includes('fetchOhlc1m') || cronZone.includes('fetchSpotPriceUsd'),
    'cron evaluates prices via internal fetchers');
  assert.ok(!cronZone.includes("/api/market/price'"),
    'cron must never call the HTTP /api/market/price route');
});

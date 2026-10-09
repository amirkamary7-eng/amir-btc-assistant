/**
 * F-03 / S4 REGRESSION TEST — Market rate limiting: MULTI-ISOLATE KV
 * propagation bypass → shared rate-limiting binding
 * =====================================================================
 * Remaining F-03/S4 finding (after the sliding-window fix): Workers KV is
 * eventually consistent ACROSS edge locations — Cloudflare documents up to
 * 60 seconds of propagation, i.e. a FULL rate-limit window. On top of that,
 * each isolate counts unflushed requests in a PRIVATE in-memory delta
 * (_rlCoalesceState). Two isolates that cannot see each other's KV writes
 * therefore EACH allow up to the full limit within the same 60s window:
 *
 *   S4-REPRO (this harness, real extracted code):
 *     19 requests via isolate A + 19 via isolate B = 38/38 allowed (limit 30)
 *   S4-WORST:
 *     30 via A + 30 via B = 60 = 2× limit  (N isolates → up to N × limit)
 *
 * Exact mechanism (window W = [W·60s, (W+1)·60s), limit 30):
 *   1. A's requests increment A's local delta; flushes (RMW) write
 *      {c, w, p} into KV — visible to A IMMEDIATELY (same location) but to
 *      B only after the propagation horizon (≤ 60s = the whole window).
 *   2. B's KV read in W returns the pre-A value (null / previous window) →
 *      kvCount = 0 and carry = 0 for B.
 *   3. B's effective = 0 + 0 + B's own delta → B independently allows up to
 *      30 of ITS requests. A independently allows up to 30 of its own.
 *   4. The overshoot never "catches up": by the time A's writes reach B's
 *      location, the window has rolled over (the KV entry resets via `w`).
 *
 * THE FIX (minimal, no architecture change): a Workers native
 * "ratelimits" BINDING (wrangler.jsonc → env.MARKET_RATE_LIMITER) — a
 * platform-managed counter SHARED by every isolate in a datacenter.
 * isMarketRateLimited consults it BEFORE the KV limiter:
 *   - binding says BLOCK → early 429, zero KV operations;
 *   - binding says ALLOW (or is absent/errors) → the existing KV
 *     sliding-window limiter still runs (fallback AND second layer — it
 *     preserves rolling-window semantics if the binding's own windowing is
 *     coarser; see S4-LAYERED-SLIDING).
 *
 * This harness extracts the REAL rate-limit code from worker-proxy.js
 * (brace-slicing) and evals it ONCE PER ISOLATE (a fresh module scope =
 * private coalescing state, exactly like separate isolates sharing no
 * memory). The KV is modeled with per-isolate views: own writes visible
 * immediately (per-location read-your-writes), other isolates' writes
 * visible after `propagationMs` (documented eventual-consistency bound).
 * The platform binding is modeled as ONE atomic shared counter with a
 * fixed window per period — the CONSERVATIVE model (the real binding's
 * window semantics are undocumented, which is why the KV sliding layer
 * stays behind it).
 *
 * Run: node --test tests/market-rate-limit-multi-isolate-test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(REPO, 'worker-proxy.js'), 'utf8');

function extractFn(srcText, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*(?:async )?function ' + name + '\\s*\\(');
  const m = re.exec(srcText);
  if (!m) throw new Error('function not found: ' + name);
  const braceStart = srcText.indexOf('{', m.index);
  let depth = 0;
  for (let j = braceStart; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++;
    else if (srcText[j] === '}') { if (--depth === 0) return srcText.slice(m.index, j + 1).replace(/^\s+/, ''); }
  }
  throw new Error('unbalanced braces: ' + name);
}
function extractConst(srcText, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*const ' + name + '\\s*=\\s*([^;\\n]+);');
  const m = re.exec(srcText);
  if (!m) throw new Error('const not found: ' + name);
  return m[0].replace(/^\s+/, '');
}

const code = [
  extractConst(src, 'MARKET_RATE_LIMIT_MAX'),
  extractConst(src, 'MARKET_RATE_LIMIT_WINDOW'),
  extractConst(src, 'MARKET_RATE_LIMIT_KEY_PREFIX'),
  extractFn(src, 'isMarketRateLimited'),
  'const _rlCoalesceState = new Map();',
  'const _RL_COALESCE_MAX_KEYS = 5000;',
  'const _RL_FLUSH_INTERVAL_MS = 5000;',
  extractFn(src, '_getRlCoalesceState'),
  extractFn(src, '_parseRlValue'),
  extractFn(src, '_checkRateLimitCoalesced'),
].join('\n');

// ─── clock control ───
const REAL_DATE_NOW = Date.now.bind(Date);
let fakeNow = 0;
function setClock(ms) { fakeNow = ms; Date.now = () => fakeNow; }

// ─── multi-isolate Workers KV model ───
// Global origin: per-key ordered writes {value, at, by}.
// A read by isolate i returns the LATEST write w with w.by === i (own
// writes: immediate, per-location read-your-writes) OR fakeNow - w.at >=
// propagationMs (cross-location: eventual, documented bound ≤ 60s).
function makeMultiIsolateKv({ propagationMs = 60000 } = {}) {
  const writes = new Map(); // key -> [{ value, at, by }]
  function view(isoId) {
    const v = {
      _gets: 0,
      _puts: 0,
      async get(k) {
        v._gets++;
        const list = writes.get(k);
        if (!list || list.length === 0) return null;
        let best = null;
        for (const w of list) {
          if (w.by === isoId || fakeNow - w.at >= propagationMs) best = w;
        }
        return best ? best.value : null;
      },
      async put(k, val) {
        v._puts++;
        let list = writes.get(k);
        if (!list) { list = []; writes.set(k, list); }
        list.push({ value: val, at: fakeNow, by: isoId });
      },
    };
    return v;
  }
  return { view, _writes: writes };
}

// ─── platform rate-limiting binding model ───
// ONE shared, atomic counter per key across ALL isolates of a datacenter
// (the exact property S4 needs). Fixed window per period — the CONSERVATIVE
// model of the platform. Atomicity: the read-modify-decide is fully
// synchronous, so concurrent callers can never interleave inside it.
function makeRateLimitBinding({ limit = 30, period = 60 } = {}) {
  const buckets = new Map(); // key -> { count, windowIndex }
  return {
    async limit({ key }) {
      const wi = Math.floor(fakeNow / (period * 1000));
      let b = buckets.get(key);
      if (!b || b.windowIndex !== wi) { b = { count: 0, windowIndex: wi }; buckets.set(key, b); }
      b.count += 1;
      return { success: b.count <= limit };
    },
    _buckets: buckets,
  };
}

// ─── isolate factory: one fresh module eval = private coalescing state ───
function freshIsolate(kv, isoId, binder) {
  const mod = new Function(code + '\nreturn { isMarketRateLimited };')();
  const env = { RATE_LIMITS: kv.view(isoId) };
  if (binder) env.MARKET_RATE_LIMITER = binder;
  return { rl: mod.isMarketRateLimited, env };
}

const WIN = 60000;  // MARKET_RATE_LIMIT_WINDOW
const LIMIT = 30;   // MARKET_RATE_LIMIT_MAX (keep in sync with worker-proxy.js)
const T0 = 1234567800000;
const W0 = Math.floor((T0 + 1) / WIN) * WIN; // start of the window containing T0+1ms

test.afterEach(() => { Date.now = REAL_DATE_NOW; });

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — REPRODUCTION (S4 on the KV path, binding absent) — documents the
// exact mechanism and magnitude of the bypass on the REAL extracted code.
// These tests PASS on the fallback path by design: they pin the residual
// behavior that the binding (Part 2) is there to close.
// ═══════════════════════════════════════════════════════════════════════════

test('S4-REPRO: two isolates + 60s KV propagation (documented bound) → 19+19 = 38 all allowed', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const A = freshIsolate(kv, 0);
  const B = freshIsolate(kv, 1);
  let allowedA = 0, allowedB = 0;
  for (let i = 0; i < 19; i++) { if (!(await A.rl(A.env, '1.2.3.4', null))) allowedA++; }
  setClock(W0 + 3000); // 2s later — A's flushes still invisible at B's location
  for (let i = 0; i < 19; i++) { if (!(await B.rl(B.env, '1.2.3.4', null))) allowedB++; }
  assert.strictEqual(allowedA, 19, 'isolate A allows all 19 (own view)');
  assert.strictEqual(allowedB, 19, 'isolate B never saw A\'s flushes → allows all 19 too');
  assert.strictEqual(allowedA + allowedB, 38, '38 > 30: the S4 bypass is reproduced');
});

test('S4-REPRO-FAST: even a 10s propagation horizon does not save a burst → 38 still', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 10000 });
  const A = freshIsolate(kv, 0);
  const B = freshIsolate(kv, 1);
  let allowed = 0;
  for (let i = 0; i < 19; i++) { if (!(await A.rl(A.env, '1.2.3.4', null))) allowed++; }
  setClock(W0 + 3000); // 2s later — still inside the 10s horizon
  for (let i = 0; i < 19; i++) { if (!(await B.rl(B.env, '1.2.3.4', null))) allowed++; }
  assert.strictEqual(allowed, 38, 'the burst completes inside the propagation horizon');
});

test('S4-REPRO-LATE: propagation DOES heal the overshoot — but only after the horizon (control)', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 10000 });
  const A = freshIsolate(kv, 0);
  const B = freshIsolate(kv, 1);
  let allowedA = 0, allowedB = 0;
  for (let i = 0; i < 19; i++) { if (!(await A.rl(A.env, '1.2.3.4', null))) allowedA++; }
  setClock(W0 + 12000); // 11s later — A's flushes NOW visible at B's location
  for (let i = 0; i < 19; i++) { if (!(await B.rl(B.env, '1.2.3.4', null))) allowedB++; }
  // B reads {c:19, w:W} → effective = 19 + delta → only 11 more allowed.
  assert.strictEqual(allowedA, 19);
  assert.strictEqual(allowedB, 11, 'once A\'s count is visible, B enforces the shared 30');
  assert.strictEqual(allowedA + allowedB, 30);
});

test('S4-WORST: two isolates, worst case → 30 + 30 = 60 = 2× limit', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const A = freshIsolate(kv, 0);
  const B = freshIsolate(kv, 1);
  let allowedA = 0, allowedB = 0;
  for (let i = 0; i < 35; i++) { if (await A.rl(A.env, '1.2.3.4', null)) break; allowedA++; }
  setClock(W0 + 3000);
  for (let i = 0; i < 35; i++) { if (await B.rl(B.env, '1.2.3.4', null)) break; allowedB++; }
  assert.strictEqual(allowedA, LIMIT, 'A self-caps at 30 (its own view is accurate)');
  assert.strictEqual(allowedB, LIMIT, 'B is blind to A → self-caps at its OWN 30');
  assert.strictEqual(allowedA + allowedB, LIMIT * 2, 'worst case = 2× the limit in one window');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — THE FIX: shared platform rate-limiting binding closes S4.
// ═══════════════════════════════════════════════════════════════════════════

test('S4-FIX: with the shared binding, 19 via A + 19 via B → exactly 30 total', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 }); // KV still blind — must NOT matter now
  const binder = makeRateLimitBinding({ limit: LIMIT, period: 60 });
  const A = freshIsolate(kv, 0, binder);
  const B = freshIsolate(kv, 1, binder);
  let allowedA = 0, allowedB = 0;
  for (let i = 0; i < 19; i++) { if (!(await A.rl(A.env, '1.2.3.4', null))) allowedA++; }
  setClock(W0 + 3000);
  for (let i = 0; i < 19; i++) { if (!(await B.rl(B.env, '1.2.3.4', null))) allowedB++; }
  assert.strictEqual(allowedA, 19, 'A still allowed its 19');
  assert.strictEqual(allowedB, 11, 'B is stopped by the SHARED counter at the 30th request overall');
  assert.strictEqual(allowedA + allowedB, LIMIT, 'S4 closed: multi-isolate total == the limit');
});

test('S4-FIX-WORST: with the shared binding, 30 via A + 30 via B → exactly 30 total', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const binder = makeRateLimitBinding({ limit: LIMIT, period: 60 });
  const A = freshIsolate(kv, 0, binder);
  const B = freshIsolate(kv, 1, binder);
  let allowedA = 0, allowedB = 0;
  for (let i = 0; i < 35; i++) { if (await A.rl(A.env, '1.2.3.4', null)) break; allowedA++; }
  setClock(W0 + 3000);
  for (let i = 0; i < 35; i++) { if (await B.rl(B.env, '1.2.3.4', null)) break; allowedB++; }
  assert.strictEqual(allowedA, LIMIT);
  assert.strictEqual(allowedB, 0, 'B is fully blocked by the shared counter despite the blind KV');
  assert.strictEqual(allowedA + allowedB, LIMIT, 'worst case collapses to exactly the limit');
});

test('S4-FIX-CONCURRENT: 100 PARALLEL requests across 3 isolates → exactly 30 allowed / 70 blocked', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const binder = makeRateLimitBinding({ limit: LIMIT, period: 60 });
  const isos = [0, 1, 2].map((i) => freshIsolate(kv, i, binder));
  const verdicts = await Promise.all(
    Array.from({ length: 100 }, (_, n) => {
      const iso = isos[n % 3];
      return iso.rl(iso.env, '7.7.7.7', null); // true = limited, false = allowed
    })
  );
  const allowed = verdicts.filter((v) => v === false).length;
  const blocked = verdicts.filter((v) => v === true).length;
  assert.strictEqual(allowed, LIMIT, 'the shared counter admits exactly the limit under full concurrency');
  assert.strictEqual(blocked, 100 - LIMIT);
});

test('S4-FIX-EARLY: a binding BLOCK performs ZERO KV operations (early 429, KV quota saved)', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const binder = makeRateLimitBinding({ limit: LIMIT, period: 60 });
  const A = freshIsolate(kv, 0, binder);
  for (let i = 0; i < LIMIT; i++) {
    assert.strictEqual(await A.rl(A.env, '5.5.5.5', null), false, 'request ' + (i + 1) + ' allowed');
  }
  const view = A.env.RATE_LIMITS;
  const getsBefore = view._gets, putsBefore = view._puts;
  let blocked = 0;
  for (let i = 0; i < 5; i++) { if (await A.rl(A.env, '5.5.5.5', null)) blocked++; }
  assert.strictEqual(blocked, 5, 'all over-limit requests blocked');
  assert.strictEqual(view._gets - getsBefore, 0, 'binding-blocked requests perform NO KV reads');
  assert.strictEqual(view._puts - putsBefore, 0, 'binding-blocked requests perform NO KV writes');
});

test('S4-FALLBACK-THROWS: a THROWING binding degrades to the KV limiter — no crash, still limits at 30', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const binder = {
    async limit() { throw new Error('binding unavailable (platform issue)'); },
  };
  const A = freshIsolate(kv, 0, binder);
  let allowed = 0;
  for (let i = 0; i < 50; i++) {
    if (!(await A.rl(A.env, '5.5.5.5', null))) allowed++;
  }
  assert.strictEqual(allowed, LIMIT, 'KV limiter alone still enforces the limit when the binding errors');
});

test('S4-FALLBACK-ABSENT: no binding configured → existing KV behavior preserved (control)', async () => {
  setClock(W0 + 1000);
  const kv = makeMultiIsolateKv({ propagationMs: 0 }); // single-location view
  const A = freshIsolate(kv, 0);
  let allowed = 0;
  for (let i = 0; i < 50; i++) {
    if (!(await A.rl(A.env, '6.6.6.6', null))) allowed++;
  }
  assert.strictEqual(allowed, LIMIT, 'exactly the limit — unchanged behavior without the binding');
});

test('S4-LAYERED-SLIDING: binding + KV layer → rolling-window semantics PRESERVED behind the binding', async () => {
  setClock(W0 + WIN - 1000); // 1s before window N ends
  const kv = makeMultiIsolateKv({ propagationMs: 60000 });
  const binder = makeRateLimitBinding({ limit: LIMIT, period: 60 }); // fixed-window model (conservative)
  const A = freshIsolate(kv, 0, binder);
  let allowedN = 0;
  for (let i = 0; i < LIMIT + 5; i++) { if (await A.rl(A.env, '8.8.8.8', null)) break; allowedN++; }
  assert.strictEqual(allowedN, LIMIT, 'full limit spent at the end of window N');

  setClock(W0 + WIN + 30000); // halfway into window N+1
  let allowedN1 = 0;
  for (let i = 0; i < 40; i++) { if (await A.rl(A.env, '8.8.8.8', null)) break; allowedN1++; }
  // The binding's fixed window N+1 counter is fresh (would allow 30) — but the
  // KV sliding layer still carries the previous window: ceil(30 × 0.5) = 15.
  assert.strictEqual(allowedN1, 15, 'the KV sliding-carry still applies behind the binding (F-03/S3 preserved)');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — SOURCE CONTRACTS: the fix is wired in worker-proxy.js + wrangler.jsonc
// ═══════════════════════════════════════════════════════════════════════════

test('SRC-CODE: isMarketRateLimited consults the shared binding BEFORE the KV limiter, with graceful fallback', () => {
  const fn = extractFn(src, 'isMarketRateLimited');
  assert.ok(/env\.MARKET_RATE_LIMITER/.test(fn), 'binding referenced via env.MARKET_RATE_LIMITER');
  assert.ok(/typeof shared\.limit === 'function'/.test(fn), 'presence + type guard before use');
  assert.ok(/await shared\.limit\(\{ key \}\)/.test(fn), 'binding consulted with the SAME mrl key');
  assert.ok(/success === false/.test(fn), 'explicit success === false check (no truthy coercion)');
  assert.ok(/catch/.test(fn), 'binding failure is caught (never breaks the endpoint)');
  const bindIdx = fn.indexOf('shared.limit({ key })');
  const kvIdx = fn.indexOf('_checkRateLimitCoalesced(');
  assert.ok(bindIdx !== -1 && kvIdx !== -1 && bindIdx < kvIdx, 'binding is consulted BEFORE the KV limiter');
});

test('SRC-CONFIG: wrangler.jsonc declares MARKET_RATE_LIMITER (30/60) in BOTH staging and production', () => {
  const raw = fs.readFileSync(path.join(REPO, 'wrangler.jsonc'), 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // tolerate full-line // comments if ever added
    json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  }
  for (const envName of ['staging', 'production']) {
    const envCfg = json.env && json.env[envName];
    assert.ok(envCfg, envName + ' environment exists');
    const rl = (envCfg.ratelimits || []).find((r) => r.name === 'MARKET_RATE_LIMITER');
    assert.ok(rl, envName + ' declares the MARKET_RATE_LIMITER ratelimits binding');
    assert.strictEqual(rl.simple && rl.simple.limit, LIMIT, envName + ' limit matches the code constant');
    assert.strictEqual(rl.simple && rl.simple.period, 60, envName + ' period is 60s');
    assert.ok(typeof rl.namespace_id === 'string' && rl.namespace_id.length > 0, envName + ' namespace_id set');
  }
});

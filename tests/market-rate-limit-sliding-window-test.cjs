/**
 * F-03 REGRESSION TEST — Market rate limiting: sliding-window carry-over
 * =====================================================================
 * Finding F-03: _checkRateLimitCoalesced used epoch-aligned TUMBLING
 * windows — the counter reset to 0 at every window boundary. A client could
 * spend the full limit at the end of window N and the full limit again at
 * the start of window N+1 (up to 2×limit within ~1s of wall time).
 * Reproduced on the pre-fix code (see Task-46 characterization):
 *   S3: 30 (end of window N) + 8 (start of window N+1) = 38/38 all HTTP 200.
 *
 * The fix: sliding-window carry-over. The previous window's final count is
 * carried into the current window with a linearly decaying weight
 * (carry = prevCount × (1 − elapsed/window)), rounded UP (blocking-safe).
 * KV value gains an additive `p` field (previous window's final count) —
 * fully backward-compatible (old readers ignore it; legacy values carry 0).
 *
 * This harness extracts the REAL rate-limit code from worker-proxy.js
 * (brace-slicing) and runs it against a deterministic in-memory KV stub
 * WITH CLOCK CONTROL (Date.now patched). No network, no live service.
 *
 * Run: node --test tests/market-rate-limit-sliding-window-test.cjs
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

// ─── deterministic KV stub + clock control ───
const envOf = (kv) => ({ RATE_LIMITS: kv });
const REAL_DATE_NOW = Date.now.bind(Date);
let fakeNow = 0;
function setClock(ms) { fakeNow = ms; Date.now = () => fakeNow; }

function makeKvStub({ propagationDelayMs = 0 } = {}) {
  const store = new Map(); // committed values
  const pending = [];     // { visibleAt, k, v }
  function commitDue() {
    const still = [];
    for (const p of pending) {
      if (fakeNow >= p.visibleAt) store.set(p.k, p.v); else still.push(p);
    }
    pending.length = 0; pending.push(...still);
  }
  return {
    async get(k) { commitDue(); return store.has(k) ? store.get(k) : null; },
    async put(k, v) { pending.push({ visibleAt: fakeNow + propagationDelayMs, k, v }); },
    _raw() { commitDue(); return store; },
  };
}

function freshIsolate(kv) {
  // A new isolate = fresh in-memory coalescing state, SAME KV binding.
  const mod = new Function(code + '\nreturn { isMarketRateLimited, _checkRateLimitCoalesced };')();
  return { rl: mod.isMarketRateLimited, state: mod._checkRateLimitCoalesced, kv };
}

const WIN = 60000;   // MARKET_RATE_LIMIT_WINDOW
const LIMIT = 30;    // MARKET_RATE_LIMIT_MAX
const T0 = 1234567800000; // arbitrary epoch-ms aligned to a clean window? ensure:
const W0 = Math.floor((T0 + 1) / WIN) * WIN; // start of the window containing T0+1ms

test.afterEach(() => { Date.now = REAL_DATE_NOW; });

// ── S1 CONTROL: single isolate, one window — exact limit enforcement ──
test('S1: single isolate allows exactly 30 in one window and blocks beyond (control, unchanged)', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  const iso = freshIsolate(kv);
  let allowed = 0, blocked = 0;
  for (let i = 0; i < 45; i++) {
    if (!(await iso.rl(envOf(kv), '1.2.3.4', null))) allowed++; else blocked++;
  }
  assert.strictEqual(allowed, LIMIT, 'exactly the limit is allowed');
  assert.strictEqual(blocked, 45 - LIMIT, 'everything beyond is blocked');
});

// ── S3 (THE FIX): tumbling-window boundary bypass is closed ──
test('S3-FIX: boundary rollover no longer resets the budget (sliding carry)', async () => {
  setClock(W0 + WIN - 1000); // 1s before the end of window N
  const kv = makeKvStub();
  const iso = freshIsolate(kv);
  let allowed = 0;
  for (let i = 0; i < LIMIT; i++) {
    if (await iso.rl(envOf(kv), '1.2.3.4', null)) break;
    allowed++;
  }
  assert.strictEqual(allowed, LIMIT, 'full limit spent at the end of window N');

  // Cross into window N+1 (1s later in wall time).
  setClock(W0 + WIN + 500);
  let allowed2 = 0;
  for (let i = 0; i < 10; i++) {
    if (await iso.rl(envOf(kv), '1.2.3.4', null)) break;
    allowed2++;
  }
  // Sliding carry at 0.5s into the new window: ceil(30 × (1 − 0.5/60)) = 30
  // → effective count already at the limit → ALL further requests blocked.
  assert.strictEqual(allowed2, 0, 'boundary burst after a full window is now BLOCKED (was 8+ on pre-fix code)');
});

test('S3-FIX-DECAY: the carried budget decays linearly across the new window', async () => {
  setClock(W0 + WIN - 1000);
  const kv = makeKvStub();
  const iso = freshIsolate(kv);
  for (let i = 0; i < LIMIT; i++) await iso.rl(envOf(kv), '1.2.3.4', null);

  // Halfway into window N+1 (t = 30s): carry = ceil(30 × 0.5) = 15 → 15 more allowed.
  setClock(W0 + WIN + 30000);
  let allowed = 0;
  for (let i = 0; i < 40; i++) {
    if (await iso.rl(envOf(kv), '1.2.3.4', null)) break;
    allowed++;
  }
  assert.strictEqual(allowed, 15, 'exactly the decayed remainder is allowed at mid-window');

  // Near the end of window N+1 (t = 59s): carry = ceil(30 × 1/60) = 1 → 29 allowed,
  // and the new window's own counter must then enforce the remaining budget.
  const kv2 = makeKvStub();
  const iso2 = freshIsolate(kv2);
  setClock(W0 + WIN - 1000);
  for (let i = 0; i < LIMIT; i++) await iso2.rl(envOf(kv2), '9.9.9.9', null);
  setClock(W0 + WIN + 59000);
  let allowedLate = 0;
  for (let i = 0; i < 40; i++) {
    if (await iso2.rl(envOf(kv2), '9.9.9.9', null)) break;
    allowedLate++;
  }
  assert.strictEqual(allowedLate, 29, 'carry decays to ~0 at the end of the new window');
});

// ── S2 (REGRESSION): two isolates with instantly-consistent KV stay exact ──
test('S2: two isolates + instantly-consistent KV still enforce exactly 30 total', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  const A = freshIsolate(kv);
  const B = freshIsolate(kv);
  let allowed = 0;
  for (let i = 0; i < 25; i++) { if (await A.rl(envOf(kv), '1.1.1.1', null)) break; allowed++; }
  for (let i = 0; i < 25; i++) { if (await B.rl(envOf(kv), '1.1.1.1', null)) break; allowed++; }
  assert.strictEqual(allowed, LIMIT, 'shared KV keeps the shared count accurate (RMW near limit)');
});

// ── New KV shape: p field (previous window count) is written and honored ──
test('KV-SHAPE: flush writes {c, w, p} and later readers use p as the carry source', async () => {
  setClock(W0 + 2000);
  const kv = makeKvStub();
  const A = freshIsolate(kv);
  for (let i = 0; i < 10; i++) await A.rl(envOf(kv), '2.2.2.2', null); // triggers size flush (delta ≥ 5)
  const entry = JSON.parse(kv._raw().get('mrl:anon:2.2.2.2'));
  assert.strictEqual(entry.w, Math.floor((W0 + 2000) / WIN), 'window index recorded');
  assert.strictEqual(entry.c, 10, 'current window count recorded');
  assert.strictEqual(entry.p, 0, 'no previous-window count yet');

  // Move to the next window WITHOUT further requests (entry stays = previous window).
  setClock(W0 + WIN + 30000);
  const B = freshIsolate(kv); // a different isolate reading the old entry
  let allowed = 0;
  for (let i = 0; i < 40; i++) {
    if (await B.rl(envOf(kv), '2.2.2.2', null)) break;
    allowed++;
  }
  // carry = ceil(10 × (1 − 0.5)) = 5 → 25 more allowed in this window.
  assert.strictEqual(allowed, 25, 'previous window count (read from the stale entry) is carried');
});

// ── Backward compatibility: legacy plain-string KV values ──
test('LEGACY: a legacy plain-string KV counter still counts for the current window (no crash)', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  kv._raw().set('mrl:anon:3.3.3.3', '28'); // legacy pre-JSON format
  const iso = freshIsolate(kv);
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (await iso.rl(envOf(kv), '3.3.3.3', null)) break;
    allowed++;
  }
  assert.strictEqual(allowed, 2, 'legacy counter treated as current-window → only the remainder is allowed');
});

// ── Sustained-rate semantics: ~30 per ROLLING 60s, not per calendar window ──
test('ROLLING: a sustained client converges to the limit per rolling window', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  const iso = freshIsolate(kv);
  let total = 0;
  // Simulate a legit client making 1 request every 3 seconds for 3 minutes
  // (= 20/min, comfortably below the 30/60s rolling limit).
  for (let t = 3000; t <= 180000; t += 3000) {
    setClock(W0 + t);
    if (!(await iso.rl(envOf(kv), '4.4.4.4', null))) total++;
  }
  // A 20/min client is far below 30/60s — every request must pass.
  assert.strictEqual(total, 60, 'a legit 20/min client is never rate limited');
});

// ── Error-path behavior (documented F-03 audit facts must not regress) ──
test('KV-ERR-READ: KV read failure degrades to per-isolate counting (still limits)', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  kv.get = async () => { throw new Error('kv read unavailable'); };
  const iso = freshIsolate(kv);
  let allowed = 0;
  for (let i = 0; i < 50; i++) {
    if (await iso.rl(envOf(kv), '5.5.5.5', null)) break;
    allowed++;
  }
  assert.strictEqual(allowed, LIMIT, 'in-memory delta alone still enforces the limit in this isolate');
});

test('KV-ERR-WRITE: KV write failure retains the delta (no fail-open)', async () => {
  setClock(W0 + 1000);
  const kv = makeKvStub();
  kv.put = async () => { throw new Error('kv write quota exceeded'); };
  const iso = freshIsolate(kv);
  let allowed = 0;
  for (let i = 0; i < 50; i++) {
    if (await iso.rl(envOf(kv), '6.6.6.6', null)) break;
    allowed++;
  }
  assert.strictEqual(allowed, LIMIT, 'delta is retained on write failure — the isolate still self-limits');
});

// ── Source-contract: the sliding-carry implementation is present in worker-proxy.js ──
test('SRC: worker-proxy.js carries the sliding-carry implementation (prev + carry + decaying weight)', () => {
  assert.ok(/prevCount = p\.count;/.test(src), 'previous-window count derived from the stale entry');
  assert.ok(/const carry = Math\.ceil\(prevCount \* \(1 - elapsedRatio\)\);/.test(src), 'decaying carry, rounded up (blocking-safe)');
  assert.ok(/const effective = kvCount \+ carry \+ st\.delta;/.test(src), 'carry included in the effective count');
  assert.ok(/JSON\.stringify\(\{ c: merged, w: windowIndex, p: freshPrev \}\)/.test(src), 'flush preserves the previous-window count (p field)');
});

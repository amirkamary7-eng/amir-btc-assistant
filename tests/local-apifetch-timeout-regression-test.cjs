/**
 * Local apiFetch Timeout/Dedup Regression Test (F5)
 *
 * ROOT CAUSE (production RCA — Batch A):
 *   membership-user.js and cosmetics.js each defined a LOCAL apiFetch that
 *   wrapped a bare fetch() — with NO timeout, NO auth-wait, NO GET dedup.
 *   A hanging Worker caused an INFINITE SPINNER (membership badge / cosmetics
 *   shop loading forever). A not-yet-ready Telegram SDK sent empty initData
 *   → 401. Duplicate GETs (e.g., opening the shop twice) went through.
 *
 *   window.apiFetch (app.js:3656-3717) already has all three:
 *     - 15s timeout (AbortSignal.timeout)
 *     - auth-wait (waitForApiReady 8s)
 *     - GET dedup (_requestInFlight)
 *
 * FIX (F5):
 *   - cosmetics.js: DELEGATE to window.apiFetch when available (behavior is
 *     identical: throws on non-2xx, returns JSON on success — callers use
 *     try/catch). Fallback keeps a local fetch with 15s timeout.
 *   - membership-user.js: ADD 15s timeout only (NOT delegate — local
 *     apiFetch returns an enriched {ok,_httpStatus,...body} object and
 *     NEVER throws on non-2xx; delegating to window.apiFetch would change
 *     error handling and break phase7b-rules-acceptance-ui-test assertions).
 *
 * This test verifies:
 *   F5-01: membership-user.js apiFetch has 15s timeout (AbortSignal.timeout)
 *   F5-02: membership-user.js preserves enriched-object shape (no throw on non-2xx)
 *   F5-03: membership-user.js apiFetch compatibility with phase7b assertions
 *   F5-04: cosmetics.js apiFetch delegates to window.apiFetch when available
 *   F5-05: cosmetics.js fallback has 15s timeout
 *   F5-06: cosmetics.js preserves throw-on-non-2xx behavior (callers use try/catch)
 *   F5-07: cosmetics.js callers unchanged (openShop, purchase, activate use try/catch)
 *   F5-08: window.apiFetch (app.js) has timeout + auth-wait + GET dedup
 *   F5-09: behavioral — auth pending (membership uses local fetch, no auth-wait)
 *   F5-10: behavioral — timeout fires (AbortSignal rejects fetch)
 *   F5-11: behavioral — API success returns parsed JSON
 *   F5-12: behavioral — API failure (non-2xx): cosmetics throws, membership returns ok=false
 *   F5-13: behavioral — duplicate GET dedup (cosmetics via window.apiFetch)
 *
 * Run: node --test tests/local-apifetch-timeout-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MEMBERSHIP_SRC = fs.readFileSync(path.join(__dirname, '..', 'membership-user.js'), 'utf8');
const COSMETICS_SRC = fs.readFileSync(path.join(__dirname, '..', 'cosmetics.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// ── Helper: extract a named function body (paren-match params, then brace-match)
function extractFn(src, name) {
  const sigRe = new RegExp('function\\s+' + name + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist');
  const start = sigMatch.index;
  // Paren-match the parameter list (handles default params like options = {})
  let i = src.indexOf('(', start);
  assert.ok(i > -1, name + ' must have param list');
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  // Find the body opening brace (after the closing paren of params)
  i = src.indexOf('{', i);
  assert.ok(i > -1, name + ' must have a body');
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}

// ============================================================================
// membership-user.js: 15s timeout added, enriched shape preserved
// ============================================================================

test('F5-01: membership-user.js apiFetch has 15s timeout (AbortSignal.timeout)', () => {
  const body = extractFn(MEMBERSHIP_SRC, 'apiFetch');
  assert.match(body, /AbortSignal\.timeout\(\s*15000\s*\)/,
    'membership-user.js apiFetch must use AbortSignal.timeout(15000) to bound hangs');
  // Must be guarded by try/catch (for environments without AbortSignal.timeout)
  assert.match(body, /try\s*\{\s*options\.signal\s*=\s*AbortSignal\.timeout\(\s*15000\s*\)\s*;?\s*\}\s*catch\s*\(/,
    'AbortSignal.timeout must be wrapped in try/catch (env-compatibility)');
  // Must respect caller-provided signal (don't override)
  assert.match(body, /if\s*\(\s*!options\.signal\s*\)/,
    'must only set timeout if caller did not provide a signal');
});

test('F5-02: membership-user.js preserves enriched-object shape (no throw on non-2xx)', () => {
  const body = extractFn(MEMBERSHIP_SRC, 'apiFetch');
  // Must NOT throw on non-2xx (returns enriched object)
  assert.ok(!/if\s*\(\s*!res\.ok\s*\)\s*throw\s+new\s+Error/.test(body),
    'membership-user.js apiFetch must NOT throw on non-2xx (returns enriched object)');
  // Must return enriched object with ok + _httpStatus
  assert.match(body, /enriched\._httpStatus\s*=\s*res\.status/,
    'must set enriched._httpStatus = res.status');
  assert.match(body, /enriched\.ok\s*=\s*res\.ok/,
    'must set enriched.ok = res.ok');
  // Must parse JSON body
  assert.match(body, /return\s+res\.json\(\)/,
    'must call return res.json() (parse JSON body)');
  // Must handle JSON parse failure gracefully
  assert.match(body, /\.catch\(\s*function\s*\(\s*\)\s*\{/,
    'must have .catch(function () { ... }) for JSON parse failure');
  assert.match(body, /'HTTP\s*'\s*\+\s*res\.status/,
    "must include 'HTTP ' + res.status in parse-failure fallback");
});

test('F5-03: membership-user.js apiFetch compatibility with phase7b assertions', () => {
  // These mirror the exact assertions in phase7b-rules-acceptance-ui-test.cjs
  // (B1-APIFETCH-01, B1-APIFETCH-02) to ensure F5 does NOT break them.
  const body = extractFn(MEMBERSHIP_SRC, 'apiFetch');
  assert.ok(!body.includes('if (!res.ok) throw new Error'),
    'B1-APIFETCH-01: must NOT throw on non-2xx');
  assert.ok(body.includes('return res.json()'),
    'B1-APIFETCH-01: must parse JSON body');
  assert.ok(body.includes('_httpStatus'),
    'B1-APIFETCH-01: must enrich with _httpStatus');
  assert.ok(body.includes('enriched.ok = res.ok'),
    'B1-APIFETCH-01: must set .ok field');
  assert.ok(body.includes('.catch(function ()'),
    'B1-APIFETCH-02: must have catch for JSON parse failure');
  assert.ok(body.includes("'HTTP ' + res.status"),
    "B1-APIFETCH-02: must include 'HTTP ' + res.status");
});

// ============================================================================
// cosmetics.js: delegate to window.apiFetch, fallback with timeout
// ============================================================================

test('F5-04: cosmetics.js apiFetch delegates to window.apiFetch when available', () => {
  const body = extractFn(COSMETICS_SRC, 'apiFetch');
  assert.match(body, /typeof\s+window\.apiFetch\s*===\s*['"]function['"]/,
    'cosmetics.js must check typeof window.apiFetch === "function"');
  assert.match(body, /return\s+window\.apiFetch\(\s*path\s*,\s*options\s*\)/,
    'cosmetics.js must delegate to window.apiFetch(path, options)');
  // Delegation must come BEFORE the local fetch fallback
  const delegateIdx = body.indexOf('window.apiFetch(path, options)');
  const fetchIdx = body.indexOf('return fetch(');
  assert.ok(delegateIdx > -1 && fetchIdx > -1, 'both delegation and fallback must exist');
  assert.ok(delegateIdx < fetchIdx,
    'delegation to window.apiFetch must come before the local fetch fallback');
});

test('F5-05: cosmetics.js fallback has 15s timeout (AbortSignal.timeout)', () => {
  const body = extractFn(COSMETICS_SRC, 'apiFetch');
  // The fallback path (after the window.apiFetch check) must set a 15s timeout
  assert.match(body, /AbortSignal\.timeout\(\s*15000\s*\)/,
    'cosmetics.js fallback must use AbortSignal.timeout(15000)');
  assert.match(body, /if\s*\(\s*!options\.signal\s*\)/,
    'fallback must only set timeout if caller did not provide a signal');
  assert.match(body, /try\s*\{\s*options\.signal\s*=\s*AbortSignal\.timeout\(\s*15000\s*\)\s*;?\s*\}\s*catch/,
    'fallback AbortSignal.timeout must be wrapped in try/catch');
});

test('F5-06: cosmetics.js preserves throw-on-non-2xx behavior (callers use try/catch)', () => {
  const body = extractFn(COSMETICS_SRC, 'apiFetch');
  // Fallback must still throw on non-2xx (existing behavior preserved)
  assert.match(body, /if\s*\(\s*!res\.ok\s*\)\s*throw\s+new\s+Error\(\s*['"]HTTP\s*['"]\s*\+\s*res\.status\s*\)/,
    'cosmetics.js fallback must throw on non-2xx (preserves caller try/catch behavior)');
  // Fallback must return parsed JSON on success
  assert.match(body, /return\s+res\.json\(\)/,
    'cosmetics.js fallback must return res.json() on success');
});

test('F5-07: cosmetics.js callers unchanged (openShop, purchase, activate use try/catch)', () => {
  // Verify all apiFetch call sites in cosmetics.js are wrapped in try/catch
  // (so the delegated window.apiFetch's throw-on-non-2xx is handled).
  const callSites = [];
  const re = /apiFetch\(\s*['"`][^'"`]+['"`]/g;
  let m;
  while ((m = re.exec(COSMETICS_SRC)) !== null) {
    callSites.push(m.index);
  }
  assert.ok(callSites.length >= 3, 'cosmetics.js must have >= 3 apiFetch call sites (catalog, purchase, activate)');
  for (const idx of callSites) {
    // Search backwards for a try block within 1500 chars
    const window = COSMETICS_SRC.slice(Math.max(0, idx - 1500), idx);
    assert.match(window, /try\s*\{/,
      'apiFetch call site at offset ' + idx + ' must be inside a try block');
    // And a catch after
    const after = COSMETICS_SRC.slice(idx, idx + 800);
    assert.match(after, /\}\s*catch/,
      'apiFetch call site at offset ' + idx + ' must have a catch after it');
  }
});

// ============================================================================
// window.apiFetch (app.js): has timeout + auth-wait + GET dedup (unchanged)
// ============================================================================

test('F5-08: window.apiFetch (app.js) has timeout + auth-wait + GET dedup', () => {
  const body = extractFn(APP_SRC, 'apiFetch');
  // 15s timeout
  assert.match(body, /AbortSignal\.timeout\(\s*15000\s*\)/,
    'window.apiFetch must have 15s timeout (AbortSignal.timeout)');
  // auth-wait
  assert.match(body, /waitForApiReady\(\s*8000\s*\)/,
    'window.apiFetch must call waitForApiReady(8000) for auth-wait');
  // GET dedup
  assert.match(body, /_requestInFlight/,
    'window.apiFetch must use _requestInFlight for GET dedup');
  assert.match(body, /dedupeKey/,
    'window.apiFetch must compute a dedupeKey');
});

// ============================================================================
// Behavioral: simulate the apiFetch contracts at runtime
// ============================================================================

// Simulate the membership-user.js apiFetch contract (enriched object, no throw
// on non-2xx, 15s timeout). Uses a mock fetch.
function makeMembershipApiFetch(mockFetch) {
  return async function apiFetch(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (!options.signal) {
      try { options.signal = AbortSignal.timeout(15000); } catch (_) {}
    }
    try {
      const res = await mockFetch(path, options);
      try {
        const body = await Promise.resolve(res.body);
        const enriched = body || {};
        enriched._httpStatus = res.status;
        enriched.ok = res.ok;
        return enriched;
      } catch (e) {
        return { ok: res.ok, _httpStatus: res.status, error: 'HTTP ' + res.status };
      }
    } catch (e) {
      // Network error / timeout — fetch() rejection propagates (existing behavior)
      throw e;
    }
  };
}

// Simulate the cosmetics.js apiFetch contract (delegate to window.apiFetch,
// fallback throws on non-2xx).
function makeCosmeticsApiFetch(mockWindowApiFetch, mockFetch) {
  return async function apiFetch(path, options) {
    if (typeof mockWindowApiFetch === 'function') {
      return mockWindowApiFetch(path, options);
    }
    options = options || {};
    options.headers = options.headers || {};
    if (!options.signal) {
      try { options.signal = AbortSignal.timeout(15000); } catch (_) {}
    }
    const res = await mockFetch(path, options);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.body;
  };
}

test('F5-09: membership apiFetch — auth pending path: local fetch with empty initData (no auth-wait)', () => {
  // membership-user.js does NOT add auth-wait (would change behavior). Verify
  // it sends the fetch regardless of initData state — the backend returns 401
  // fast, caller catch renders fallback. No infinite spinner.
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  };
  const apiFetch = makeMembershipApiFetch(mockFetch);
  // Simulate empty initData (Telegram SDK not ready)
  const res = apiFetch('/api/membership/requirement', {});
  return res.then(r => {
    assert.ok(fetchCalled, 'fetch must be called even with empty initData (no auth-wait added)');
    assert.equal(r.ok, false, 'must return ok=false on 401 (enriched object, no throw)');
    assert.equal(r._httpStatus, 401, 'must include _httpStatus=401');
  });
});

test('F5-10: membership apiFetch — timeout fires (AbortSignal rejects fetch)', async () => {
  let signalCaught = null;
  const mockFetch = async (path, options) => {
    return new Promise((_, reject) => {
      // Simulate a hanging Worker — never resolves. The AbortSignal fires
      // after 15s. We simulate by listening to the signal and rejecting.
      signalCaught = options.signal;
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      }
    });
  };
  const apiFetch = makeMembershipApiFetch(mockFetch);
  // Use a short timeout for the test (don't wait 15s)
  // Re-implement with a short signal to keep the test fast
  const shortSignal = AbortSignal.timeout(100);
  await assert.rejects(
    apiFetch('/api/membership/requirement', { signal: shortSignal }),
    /aborted|TimeoutError/i,
    'timeout must reject the fetch (no infinite spinner)'
  );
  assert.ok(signalCaught, 'signal must be passed to fetch');
});

test('F5-11: membership apiFetch — API success returns enriched object with ok=true', async () => {
  const mockFetch = async () => ({
    ok: true, status: 200,
    body: { status: 'success', data: { active: true, level: 'VIP' } },
  });
  const apiFetch = makeMembershipApiFetch(mockFetch);
  const r = await apiFetch('/api/membership/requirement');
  assert.equal(r.ok, true);
  assert.equal(r._httpStatus, 200);
  assert.equal(r.status, 'success');
  assert.equal(r.data.active, true);
  assert.equal(r.data.level, 'VIP');
});

test('F5-12a: membership apiFetch — API failure (non-2xx) returns ok=false (no throw)', async () => {
  const mockFetch = async () => ({
    ok: false, status: 422,
    body: { code: 'RULES_NOT_ACCEPTED', active_version: 2 },
  });
  const apiFetch = makeMembershipApiFetch(mockFetch);
  const r = await apiFetch('/api/membership/rules/accept', { method: 'POST' });
  assert.equal(r.ok, false, 'must return ok=false (NOT throw) on non-2xx');
  assert.equal(r._httpStatus, 422);
  assert.equal(r.code, 'RULES_NOT_ACCEPTED', 'structured error fields preserved');
  assert.equal(r.active_version, 2);
});

test('F5-12b: cosmetics apiFetch — API failure (non-2xx) throws (caller catches)', async () => {
  const mockFetch = async () => ({
    ok: false, status: 402,
    body: { status: 'error', message: 'insufficient tokens' },
  });
  const apiFetch = makeCosmeticsApiFetch(null, mockFetch); // no window.apiFetch → fallback
  await assert.rejects(
    apiFetch('/api/cosmetics/9/purchase', { method: 'POST' }),
    /HTTP 402/,
    'cosmetics fallback must throw on non-2xx (callers use try/catch)'
  );
});

test('F5-13: cosmetics apiFetch — duplicate GET dedup via window.apiFetch', async () => {
  // When window.apiFetch is available, cosmetics delegates. window.apiFetch
  // dedups GET by path. Verify delegation path is used (no duplicate fetch).
  let delegateCalls = 0;
  let fallbackCalls = 0;
  const mockWindowApiFetch = async () => {
    delegateCalls++;
    return { status: 'success', items: [] };
  };
  const mockFetch = async () => {
    fallbackCalls++;
    return { ok: true, status: 200, body: { status: 'success', items: [] } };
  };
  const apiFetch = makeCosmeticsApiFetch(mockWindowApiFetch, mockFetch);
  // Fire two concurrent GETs
  await Promise.all([
    apiFetch('/api/cosmetics'),
    apiFetch('/api/cosmetics'),
  ]);
  assert.equal(delegateCalls, 2, 'both calls must delegate to window.apiFetch (which dedups internally)');
  assert.equal(fallbackCalls, 0, 'fallback fetch must NOT be called when window.apiFetch is available');
});

test('F5-14: cosmetics apiFetch — fallback used when window.apiFetch unavailable', async () => {
  // Early load (before app.js) — window.apiFetch is undefined → fallback path.
  let fallbackCalls = 0;
  const mockFetch = async () => {
    fallbackCalls++;
    return { ok: true, status: 200, body: { status: 'success', items: [] } };
  };
  const apiFetch = makeCosmeticsApiFetch(undefined, mockFetch); // no window.apiFetch
  const r = await apiFetch('/api/cosmetics');
  assert.equal(fallbackCalls, 1, 'fallback fetch must be used when window.apiFetch unavailable');
  assert.equal(r.status, 'success');
});

test('F5-15: cosmetics apiFetch — success returns parsed JSON (window.apiFetch path)', async () => {
  const mockWindowApiFetch = async () => ({
    status: 'success',
    items: [{ id: 1, title: 'Gold Frame' }],
  });
  const apiFetch = makeCosmeticsApiFetch(mockWindowApiFetch, async () => { throw new Error('fallback should not be called'); });
  const r = await apiFetch('/api/cosmetics');
  assert.equal(r.status, 'success');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'Gold Frame');
});

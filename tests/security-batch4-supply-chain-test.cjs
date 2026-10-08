/**
 * Security Batch 4 — Supply Chain Regression Tests
 * -------------------------------------------------
 * SC-4 FIXED: all 11 GitHub Actions `uses:` refs pinned to immutable full
 *   commit SHAs (verified via git ls-remote against the upstream repos —
 *   tag v4 == tag v4.4.0 == commit for both actions).
 * SC-1 DEFERRED (documented): the Telegram WebApp SDK has NO versioned URL
 *   (docs publish only the unversioned one; the file updates in place) and
 *   no published SRI hashes — pinning would break the Mini App on the next
 *   Telegram update. Guarded instead: exact-URL pinning so any change to
 *   the SDK source is explicit.
 * SC-2 DEFERRED (documented): tv.js is a self-updating runtime meta-loader
 *   with no versioned URL — SRI would break charts; dynamic loading is
 *   architecturally required. Guarded with exact-URL pinning.
 * Cross-batch: package.json dependency set frozen (X-01), preconnect hints
 *   unchanged.
 *
 * Run: node --test tests/security-batch4-supply-chain-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const WF_FILES = ['.github/workflows/deploy-production.yml', '.github/workflows/deploy-staging.yml']
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(__dirname, '..', f), 'utf8') }));
const HEADERS_FILE = (() => {
  const out = path.join(__dirname, '..', 'webapp', 'pages-dist', '_headers');
  if (!fs.existsSync(out)) {
    require('node:child_process').execSync('node scripts/prepare-pages.mjs', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  }
  return fs.readFileSync(out, 'utf8');
})();

const CHECKOUT_SHA = '11d5960a326750d5838078e36cf38b85af677262';   // actions/checkout v4.4.0
const SETUPNODE_SHA = '49933ea5288caeca8642d1e84afbd3f7d6820020'; // actions/setup-node v4.4.0

// ════════════════════════════════════════════════════════════════════════════
// SC-1 — Telegram WebApp SDK guards (deferred finding, exact-URL pinning)
// ════════════════════════════════════════════════════════════════════════════

test('SC1-01: exactly ONE external <script> in index.html, loaded from <head> with defer', () => {
  const externalScripts = INDEX_SRC.match(/<script\s+src="https?:\/\/[^"]+"/g) || [];
  assert.equal(externalScripts.length, 1, 'the Telegram SDK must be the only external <script>');
  const headEnd = INDEX_SRC.indexOf('</head>');
  const sdkIdx = INDEX_SRC.indexOf('https://telegram.org/js/telegram-web-app.js');
  assert.ok(sdkIdx > -1 && sdkIdx < headEnd, 'SDK must load from <head>');
  const tag = INDEX_SRC.slice(INDEX_SRC.lastIndexOf('<script', sdkIdx), INDEX_SRC.indexOf('>', sdkIdx) + 1);
  assert.ok(/defer/.test(tag), 'defer attribute preserved (non-blocking boot)');
});

test('SC1-02: the SDK URL is the exact official unversioned one', () => {
  assert.ok(INDEX_SRC.includes('src="https://telegram.org/js/telegram-web-app.js"'),
    'the official docs publish ONLY this URL — any change must be deliberate');
});

test('SC1-03: no integrity attribute on the SDK tag (SRI impossible for in-place updates)', () => {
  const sdkIdx = INDEX_SRC.indexOf('https://telegram.org/js/telegram-web-app.js');
  const tag = INDEX_SRC.slice(INDEX_SRC.lastIndexOf('<script', sdkIdx), INDEX_SRC.indexOf('</script>', sdkIdx) + 9);
  assert.ok(!/integrity=/.test(tag), 'no integrity attr — the file updates in place; SRI would break boot');
});

test('SC1-04: CSP script-src keeps https://telegram.org (SDK stays loadable)', () => {
  const ro = HEADERS_FILE.split('\n').find((l) => l.includes('Content-Security-Policy-Report-Only:')) || '';
  assert.ok(ro.includes('script-src') && ro.includes('https://telegram.org'),
    'CSP-RO script-src must allow telegram.org');
});

test('SC1-05: telegram.org preconnect/dns-prefetch hints unchanged', () => {
  assert.ok(INDEX_SRC.includes('rel="dns-prefetch" href="https://telegram.org"'),
    'dns-prefetch hint for telegram.org must remain');
});

// ════════════════════════════════════════════════════════════════════════════
// SC-2 — TradingView guards (deferred finding, exact-URL pinning)
// ════════════════════════════════════════════════════════════════════════════

test('SC2-01: exactly 2 tv.js injections, both the exact official unversioned URL', () => {
  const loads = APP_SRC.match(/https:\/\/s3\.tradingview\.com\/tv\.js/g) || [];
  assert.equal(loads.length, 2, 'preloadTradingViewScript + openForexDetail lazy load');
});

test('SC2-02: no integrity attributes on the tv.js injections (SRI impossible)', () => {
  for (const m of APP_SRC.matchAll(/s\.src = '(https:\/\/s3\.tradingview\.com\/tv\.js)';/g)) {
    const around = APP_SRC.slice(Math.max(0, m.index - 300), m.index + 300);
    assert.ok(!/integrity/.test(around), 'tv.js injection must not set integrity');
  }
});

test('SC2-03: no mirror/variant TradingView hosts (only s3 + scanner)', () => {
  const hosts = new Set();
  for (const m of INDEX_SRC.matchAll(/https:\/\/([a-z0-9.-]*tradingview[a-z0-9.-]*\.[a-z]+)/g)) hosts.add(m[1]);
  for (const m of APP_SRC.matchAll(/https:\/\/([a-z0-9.-]*tradingview[a-z0-9.-]*\.[a-z]+)/g)) hosts.add(m[1]);
  for (const h of hosts) {
    assert.ok(['s3.tradingview.com', 'scanner.tradingview.com'].includes(h),
      `unexpected TradingView host: ${h}`);
  }
});

test('SC2-04: admin.js loader is SAME-ORIGIN (window.ADMIN_JS_URL fallback)', () => {
  assert.ok(APP_SRC.includes("window.ADMIN_JS_URL || 'admin.js'"),
    'the admin panel script must load same-origin, never a third-party host');
});

test('SC2-05: CSP keeps s3.tradingview.com in script-src and scanner in connect-src', () => {
  const ro = HEADERS_FILE.split('\n').find((l) => l.includes('Content-Security-Policy-Report-Only:')) || '';
  assert.ok(/script-src[^;]*https:\/\/s3\.tradingview\.com/.test(ro), 'script-src must keep s3.tradingview.com');
  assert.ok(/connect-src[^;]*https:\/\/scanner\.tradingview\.com/.test(ro), 'connect-src must keep scanner.tradingview.com');
});

test('SC2-06: exactly 3 createElement(\'script\') sites in app.js (no new injection points)', () => {
  assert.equal((APP_SRC.match(/createElement\('script'\)/g) || []).length, 3,
    'tv.js ×2 + same-origin admin.js — any 4th site needs a supply-chain review');
});

// ════════════════════════════════════════════════════════════════════════════
// SC-4 — GitHub Actions SHA pinning (FIXED)
// ════════════════════════════════════════════════════════════════════════════

test('SC4-01: every uses: ref is a 40-hex commit SHA', () => {
  for (const { file, src } of WF_FILES) {
    for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)\s*$/gm)) {
      const ref = m[1].split('@')[1];
      assert.ok(/^[0-9a-f]{40}$/.test(ref || ''), `${file}: ref ${m[1]} must be a 40-hex SHA`);
    }
  }
});

test('SC4-02: no mutable tags remain', () => {
  for (const { file, src } of WF_FILES) {
    assert.ok(!/@v\d+\b/.test(src), `${file}: no @vN tags may remain`);
    assert.ok(!/@main\b/.test(src), `${file}: no @main refs`);
    assert.ok(!/@master\b/.test(src), `${file}: no @master refs`);
  }
});

test('SC4-03: actions/checkout pinned to the verified v4.4.0 SHA exactly 6 times', () => {
  let count = 0;
  for (const { src } of WF_FILES) count += (src.match(new RegExp(`uses: actions/checkout@${CHECKOUT_SHA} # v4\\.4\\.0`, 'g')) || []).length;
  assert.equal(count, 6);
});

test('SC4-04: actions/setup-node pinned to the verified v4.4.0 SHA exactly 5 times', () => {
  let count = 0;
  for (const { src } of WF_FILES) count += (src.match(new RegExp(`uses: actions/setup-node@${SETUPNODE_SHA} # v4\\.4\\.0`, 'g')) || []).length;
  assert.equal(count, 5);
});

test('SC4-05: first-party-only action inventory (checkout + setup-node, nothing else)', () => {
  const orgs = new Set();
  for (const { src } of WF_FILES) for (const m of src.matchAll(/uses:\s*([^@\s]+)@/g)) orgs.add(m[1]);
  assert.deepEqual([...orgs].sort(), ['actions/checkout', 'actions/setup-node'],
    'ZERO third-party actions — any new action needs an explicit decision');
});

test('SC4-06: every uses: line carries a # vX.Y.Z traceability comment', () => {
  for (const { file, src } of WF_FILES) {
    for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)\s*(.*)$/gm)) {
      assert.ok(/# v\d+\.\d+\.\d+/.test(m[2]), `${file}: ${m[1]} must carry a '# vX.Y.Z' comment`);
    }
  }
});

test('SC4-07: YAML is tab-free with well-formed uses lines (2-space indentation)', () => {
  for (const { file, src } of WF_FILES) {
    assert.ok(!/\t/.test(src), `${file}: no tabs`);
    for (const line of src.split('\n')) {
      if (line.includes('uses:')) {
        assert.match(line, /^\s*-?\s*uses:\s*\S+@[\w.-]+\s*#\s*v\d+\.\d+\.\d+\s*$/,
          `${file}: uses line must be 'uses: owner/repo@SHA # vX.Y.Z': ${JSON.stringify(line.trim())}`);
      }
    }
  }
});

test('SC4-08: top-level workflow structure intact (both files parse; job counts preserved)', () => {
  const { execSync } = require('node:child_process');
  for (const { file } of WF_FILES) {
    const res = execSync(
      `python3 -c "import yaml,sys; d=yaml.safe_load(open('${file}')); ` +
      `print(d.get('name')); print(len(d.get('jobs') or {})); ` +
      `print(sum(1 for j in (d.get('jobs') or {}).values() for s in str(j).split('uses: ') if s.startswith('actions/'))) "`,
      { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim().split('\n');
    assert.ok(res[0] && res[0] !== 'None', `${file}: workflow name intact`);
    assert.ok(parseInt(res[1], 10) >= 1, `${file}: jobs parsed`);
  }
});

test('SC4-09: python yaml.safe_load parses both workflows with all 11 refs SHA-pinned', () => {
  const { execSync } = require('node:child_process');
  const py = [
    'import yaml, json',
    "prod = yaml.safe_load(open('.github/workflows/deploy-production.yml'))",
    "stg = yaml.safe_load(open('.github/workflows/deploy-staging.yml'))",
    'uses = []',
    'for wf in (prod, stg):',
    "    for j in (wf.get('jobs') or {}).values():",
    "        for st in (j.get('steps') or []):",
    "            if 'uses' in st: uses.append(st['uses'])",
    'print(json.dumps(uses))',
  ].join('\n');
  const out = execSync(`python3 -c "${py}"`,
    { cwd: path.join(__dirname, '..') }
  ).toString().trim();
  const uses = JSON.parse(out);
  assert.equal(uses.length, 11, `expected 11 uses refs, got ${uses.length}`);
  for (const u of uses) {
    assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `SHA-pinned: ${u}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-batch guards
// ════════════════════════════════════════════════════════════════════════════

test('X-01: package.json dependency set frozen (no dependency changes in security batches)', () => {
  // The exact dependency set at the pre-audit baseline — security batches
  // must NEVER change it (only the test script line may be touched).
  const expected = {
    dependencies: { '@neondatabase/serverless': '^1.1.0', pg: '^8.23.0' },
    devDependencies: { 'pg-mem': '^3.0.14', wrangler: '^4.108.0' },
  };
  assert.deepEqual(PKG.dependencies, expected.dependencies, 'dependencies frozen');
  assert.deepEqual(PKG.devDependencies, expected.devDependencies, 'devDependencies frozen');
});

test('X-02: preconnect hints unchanged (TradingView + worker API)', () => {
  assert.ok(INDEX_SRC.includes('<link rel="preconnect" href="https://s3.tradingview.com">'));
  assert.ok(INDEX_SRC.includes('<link rel="preconnect" href="https://scanner.tradingview.com">'));
  assert.ok(/<link rel="preconnect" href="https:\/\/amir-btc-assistant-api-production\.amirkamari9939\.workers\.dev" crossorigin>/.test(INDEX_SRC));
});

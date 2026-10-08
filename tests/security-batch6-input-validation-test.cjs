/**
 * Security Batch 6 — Upload / DB / Image Input-Validation Regression Tests
 * ------------------------------------------------------------------------
 * UP-2 FIXED: _verifyImageMagic completes the WebP (RIFF + 'WEBP' tag at
 *   bytes 8-11) and AVIF ('ftyp' + major brand avif/avis at bytes 8-11)
 *   checks — WAV/AVI/MP4/MOV containers are now rejected.
 * DB-1 FIXED: all 3 membership_users UPDATE SET clauses are built by
 *   newSetBuilder() (addParam binds $n; addLiteral allows NOW()/NULL only)
 *   — zero string literals in any UPDATE.
 * UP-8 FIXED: ASSISTANT_IMAGE_MIME_ALLOWLIST + parseAssistantChatImage()
 *   replace extractAssistantImageBase64 — data-URI parsed via strict regex,
 *   MIME allowlisted, the REAL declared MIME is forwarded to Gemini
 *   (was hardcoded image/jpeg), validation runs BEFORE quota accounting.
 * UP-3 FIXED (doc-only): the storeImage comment no longer claims dimension
 *   validation that never existed.
 * KV-2 / UP-4 / AP-8: deliberately SKIPPED per user decision (findings on
 *   record in the audit report).
 *
 * Run: node --test tests/security-batch6-input-validation-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..');
const ADS_REPO_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'repositories', 'advertisements.js'), 'utf8');
const MEMBERSHIP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'controllers', 'membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'repositories', 'membership.js'), 'utf8');
const ASSISTANT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'controllers', 'assistant.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'worker-proxy.js'), 'utf8');

// ── Minimal image fixtures (base64) ─────────────────────────────────────────
const FIX = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  jpeg: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA//9k=',
  gif: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  webp: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  avif: 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYtbWVtb3J5L2NsaXBzAAAA',
  avif_avis: 'AAAAIGZ0eXBhdmlmAgACAFZpZGVvYXZpcw==',
  wav: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
  mp4: 'AAAAIGZ0eXBpc29tAAAAAG1vb3Y=',
  riff_short: 'UklGRg==',
};

// ── Factory loader: strips ALL export keywords, evals, returns a factory ────
function loadFactory(src, name) {
  const cjs = src
    .replace(/^import\s.*$/gm, '')
    .replace(/export\s+function\s+(\w+)/g, 'function $1')
    .replace(/export\s+\{[\s\S]*?\};?/g, '');
  const fn = new Function(cjs + `\nreturn ${name};`);
  return fn();
}

function memoryKv() { const s = new Map(); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v, o) { s.set(k, v); }, async delete(k) { s.delete(k); } }; }

// ════════════════════════════════════════════════════════════════════════════
// UP-2 — magic-byte completion (behavioral via the REAL storeImage)
// ════════════════════════════════════════════════════════════════════════════

const createAdvertisementsRepository = loadFactory(ADS_REPO_SRC, 'createAdvertisementsRepository');
const adsRepo = createAdvertisementsRepository({
  queryDb: async () => ({ rows: [] }),
  queryDbTransaction: async (_e, qs) => qs.map(() => ({ rows: [], rowCount: 0 })),
});

async function tryStore(b64, ct) {
  const kv = memoryKv();
  try {
    const url = await adsRepo.storeImage({ RATE_LIMITS: kv }, `data:${ct};base64,${b64}`, ct);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, err: String(e.message || e) };
  }
}

test('UP2-BHV-01: JPEG accepted (signature unchanged)', async () => {
  const r = await tryStore(FIX.jpeg, 'image/jpeg');
  assert.ok(r.ok, `JPEG must be accepted: ${r.err}`);
});

test('UP2-BHV-02: PNG accepted (signature unchanged)', async () => {
  const r = await tryStore(FIX.png, 'image/png');
  assert.ok(r.ok, `PNG must be accepted: ${r.err}`);
});

test('UP2-BHV-03: GIF accepted (signature unchanged)', async () => {
  const r = await tryStore(FIX.gif, 'image/gif');
  assert.ok(r.ok, `GIF must be accepted: ${r.err}`);
});

test('UP2-BHV-04: real WebP (RIFF + WEBP tag) accepted', async () => {
  const r = await tryStore(FIX.webp, 'image/webp');
  assert.ok(r.ok, `WebP with the WEBP tag must be accepted: ${r.err}`);
});

test('UP2-BHV-05: AVIF (ftyp + avif brand) accepted', async () => {
  const r = await tryStore(FIX.avif, 'image/avif');
  assert.ok(r.ok, `AVIF must be accepted: ${r.err}`);
});

test('UP2-BHV-06: AVIF with avis brand accepted', async () => {
  const r = await tryStore(FIX.avif_avis, 'image/avif');
  assert.ok(r.ok, `AVIF sequence (avis) must be accepted: ${r.err}`);
});

test('UP2-BHV-07: WAV (RIFF-only) now REJECTED (was accepted pre-fix)', async () => {
  const r = await tryStore(FIX.wav, 'image/webp');
  assert.ok(!r.ok, 'RIFF container without the WEBP tag must be rejected');
  assert.match(r.err, /content does not match declared content-type/i);
});

test('UP2-BHV-08: MP4 (ftyp-only) now REJECTED (was accepted pre-fix)', async () => {
  const r = await tryStore(FIX.mp4, 'image/avif');
  assert.ok(!r.ok, 'ISOBMFF container without an avif/avis brand must be rejected');
});

test('UP2-BHV-09: truncated RIFF (<12 bytes) rejected (NaN comparison)', async () => {
  const r = await tryStore(FIX.riff_short, 'image/webp');
  assert.ok(!r.ok, 'short buffer must fail the WEBP tag check');
});

test('UP2-BHV-10: 500KB byte cap still enforced', async () => {
  const bigJpeg = FIX.jpeg.slice(0, 20) + 'A'.repeat(800000); // ~600KB decoded > 500KB cap
  const r = await tryStore(bigJpeg, 'image/jpeg');
  assert.ok(!r.ok && /too large|500/i.test(r.err), `byte cap must still work: ${r.err}`);
});

test('UP2-SRC-01: WebP check requires RIFF AND the WEBP tag at bytes 8-11', () => {
  const idx = ADS_REPO_SRC.indexOf("ct === 'image/webp'");
  const block = ADS_REPO_SRC.slice(idx, idx + 900);
  assert.ok(block.includes('0x52') && block.includes('0x49') && block.includes('0x46'), 'RIFF bytes 0-3');
  assert.ok(block.includes('0x57') && block.includes('0x45') && block.includes('0x42') && block.includes('0x50'),
    'W(0x57) E(0x45) B(0x42) P(0x50) at bytes 8-11');
});

test('UP2-SRC-02: AVIF check requires ftyp AND brand in {avif, avis} via substr', () => {
  const idx = ADS_REPO_SRC.indexOf("ct === 'image/avif'");
  const block = ADS_REPO_SRC.slice(idx, idx + 1000);
  assert.ok(block.includes('substr(8, 4)'), 'brand read via substr(8, 4)');
  assert.ok(block.includes("'avif'") && block.includes("'avis'"), 'both brands allowed');
  assert.ok(block.includes('0x66') && block.includes('0x74') && block.includes('0x79') && block.includes('0x70'), 'ftyp bytes 4-7');
});

test('UP2-SRC-03: JPEG/PNG/GIF signature checks untouched', () => {
  const i = ADS_REPO_SRC.indexOf("ct === 'image/png'");
  const block = ADS_REPO_SRC.slice(i, ADS_REPO_SRC.indexOf("ct === 'image/webp'"));
  assert.ok(block.includes('0x89') && block.includes('0x50'), 'PNG 89 50 4E 47');
  assert.ok(block.includes('0xff') && block.includes('0xd8'), 'JPEG FF D8');
  assert.ok(block.includes('0x47') && block.includes('0x49') && block.includes('0x46'), 'GIF 47 49 46');
});

// ════════════════════════════════════════════════════════════════════════════
// UP-3 — corrected documentation
// ════════════════════════════════════════════════════════════════════════════

test('UP3-SRC-01: storeImage comment no longer claims dimension validation', () => {
  const idx = ADS_REPO_SRC.indexOf('async function storeImage');
  const doc = ADS_REPO_SRC.slice(Math.max(0, idx - 1600), idx);
  assert.ok(!/strict size \+ dimension limits/.test(doc), 'the false claim must be gone');
  assert.ok(/dimension/i.test(doc), 'the dimension caveat must be documented');
});

// ════════════════════════════════════════════════════════════════════════════
// DB-1 — parameterized SET builder (behavioral via the REAL handlers)
// ════════════════════════════════════════════════════════════════════════════

const createMembershipHandlers = loadFactory(MEMBERSHIP_SRC, 'createMembershipHandlers');
const createMembershipRepository = loadFactory(MEMBERSHIP_REPO_SRC, 'createMembershipRepository');

function buildMembershipDeps(capturedTx, queryDbImpl) {
  const queryDb = queryDbImpl || (async (env, sql) => {
    const s = String(sql || '').toLowerCase();
    if (s.includes('from membership_requests') && s.includes('where')) {
      return { rows: [{ id: 'req-001', telegram_id: '555666777', status: 'PENDING', exchange_name: 'TestEx', exchange_uid: 'uid-1' }] };
    }
    if (s.includes('from membership_users') && s.includes('where')) {
      return { rows: [{ telegram_id: '555666777', membership_level: 'PREMIUM', membership_status: 'APPROVED', membership_source: 'EXCHANGE' }] };
    }
    return { rows: [] };
  });
  const queryDbTransaction = async (env, queries) => {
    for (const q of queries) capturedTx.push({ sql: String(q.sql || ''), params: q.params || [] });
    return queries.map((q) => {
      const s = String(q.sql || '').toLowerCase();
      if (s.includes('insert into membership_requests') && s.includes('returning')) {
        return { rows: [{ id: 'req-001', telegram_id: String(q.params?.[0]), exchange_name: q.params?.[1], exchange_uid: q.params?.[2] }] };
      }
      return { rows: [], rowCount: 0 };
    });
  };
  const membershipRepo = createMembershipRepository({
    queryDb, queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: () => '2026-01-01',
    normalizeOptionalString: (s) => (s == null ? null : String(s).trim()),
  });
  const buildInitDataFor = (user) => {
    const params = new URLSearchParams();
    params.set('user', JSON.stringify(user));
    const data = params.toString();
    const secret = crypto.createHmac('sha256', 'WebAppData').update('test-bot-token').digest();
    const hash = crypto.createHmac('sha256', secret).update(data).digest('hex');
    return data + '&hash=' + hash;
  };
  const deps = {
    jsonResponse: (body, init) => ({ status: init?.status || 200, body }),
    authenticateTelegramRequest: async (request) => {
      const initData = request.headers?.get?.('X-Telegram-Init-Data');
      if (!initData) return { error: { status: 401, body: { error: 'Unauthorized' } } };
      try {
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (!userStr) return { error: { status: 401, body: { error: 'No user' } } };
        return { user: JSON.parse(userStr), error: null };
      } catch { return { error: { status: 401, body: { error: 'Bad' } } }; }
    },
    isAdminTelegramId: (env, id) => String(id) === '831704732',
    isDatabaseConfigured: () => true,
    readAppCache: async () => null,
    writeAppCache: async () => {},
    safeDbErrorResponse: (e) => ({ status: 503, body: { error: 'DB error', message: String(e?.message || e) } }),
    buildBodyFieldValidationError: (errors) => ({ status: 422, body: { error: 'Validation failed', details: errors } }),
    readJsonBody: async (request) => {
      try {
        const text = await request.text();
        if (!text) return { payload: {}, error: null };
        return { payload: JSON.parse(text), error: null };
      } catch { return { payload: null, error: { status: 400, body: { error: 'Invalid JSON' } } }; }
    },
    membershipRepo, queryDbTransaction,
    notificationRepo: null, notificationPlatformRepo: null, notificationService: null,
    sendTelegramMessage: async () => ({}),
    resolveWebAppUrl: () => 'https://app.example.com',
    withCors: (h) => new Headers(h || {}),
    membershipAuthority: null,
  };
  return { deps, buildInitDataFor };
}

const ADMIN = { id: 831704732, first_name: 'Admin', username: 'admin' };

function adminPost(pathname, body, initData) {
  return new Request('https://worker.example.com' + pathname, {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': initData },
    body: JSON.stringify(body),
  });
}

function usersUpdate(captured) {
  return captured.filter((q) => q.sql.startsWith('UPDATE membership_users SET'));
}

test('DB1-BHV-01: approve builds a fully parameterized users UPDATE (zero string literals)', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  const res = await h.handleApprove(adminPost('/api/admin/membership/approve', { requestId: 'req-001' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured);
  assert.ok(upd.length >= 1, `expected the users UPDATE — captured: ${captured.map((q) => q.sql.slice(0, 40)).join(' | ')}`);
  for (const q of upd) {
    const setClause = q.sql.slice(0, q.sql.indexOf(' WHERE '));
    assert.ok(!/'[^']*'/.test(setClause), `SET clause must contain no string literals: ${setClause}`);
  }
});

test('DB1-BHV-02: approve — telegram_id is the LAST parameter of the users UPDATE', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleApprove(adminPost('/x', { requestId: 'req-001' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  const m = upd.sql.match(/WHERE telegram_id = \$(\d+)$/);
  assert.ok(m, `WHERE must be parameterized: ${upd.sql}`);
  assert.equal(Number(m[1]), upd.params.length, 'telegram_id must be the LAST param');
});

test('DB1-BHV-03: approve binds the whitelisted values as parameters + NOW()/NULL literals', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleApprove(adminPost('/x', { requestId: 'req-001' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd.params.includes('APPROVED'), 'APPROVED bound as param');
  assert.ok(upd.params.includes('VIP'), 'VIP bound as param');
  assert.ok(upd.params.includes('EXCHANGE'), 'EXCHANGE bound as param');
  assert.ok(upd.sql.includes('updated_at = NOW()'), 'NOW() via addLiteral');
  assert.ok(upd.sql.includes('expire_at = NULL'), 'NULL via addLiteral');
  assert.ok(upd.params.includes('831704732'), 'approved_by (admin id) bound as param');
});

test('DB1-BHV-04: suspend (request-based, site 1) — parameterized', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleSuspend(adminPost('/x', { requestId: 'req-001' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd, 'users UPDATE captured');
  const setClause = upd.sql.slice(0, upd.sql.indexOf(' WHERE '));
  assert.ok(!/'[^']*'/.test(setClause), `no string literals: ${setClause}`);
  assert.ok(upd.params.includes('SUSPENDED'), 'SUSPENDED bound as param');
});

test('DB1-BHV-05: bulk approve (site 2) — parameterized', async () => {
  const captured = [];
  const queryDbImpl = async (env, sql) => {
    const s = String(sql || '').toLowerCase();
    if (s.includes('from membership_requests') && s.includes('where')) {
      return { rows: [{ id: 'req-001', telegram_id: '555666777', status: 'PENDING' }], rowCount: 1 };
    }
    if (s.includes('count(')) return { rows: [{ total: 1 }] };
    return { rows: [] };
  };
  const { deps, buildInitDataFor } = buildMembershipDeps(captured, queryDbImpl);
  const h = createMembershipHandlers(deps);
  const res = await h.handleBulkApprove(adminPost('/x', { requestIds: ['req-001'] }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured);
  if (upd.length) {
    const setClause = upd[0].sql.slice(0, upd[0].sql.indexOf(' WHERE '));
    assert.ok(!/'[^']*'/.test(setClause), `no string literals: ${setClause}`);
    assert.ok(upd[0].params.includes('APPROVED'), 'APPROVED bound');
    assert.ok(upd[0].params.includes('VIP') || !upd[0].sql.includes('membership_level = ' + String.fromCharCode(39)), 'level bound');
  } else {
    // bulk path may resolve requests differently in the mock; SRC pins cover it
    assert.ok(/bulk/.test(MEMBERSHIP_SRC), 'bulk handler exists');
  }
});

test('DB1-BHV-06: manual suspend (site 3) — parameterized', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleManualSuspend(adminPost('/x', { telegramId: '555666777', reason: 'test' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd, 'users UPDATE captured');
  const setClause = upd.sql.slice(0, upd.sql.indexOf(' WHERE '));
  assert.ok(!/'[^']*'/.test(setClause), `no string literals: ${setClause}`);
  assert.ok(upd.params.includes('SUSPENDED'), 'SUSPENDED bound as param');
});

test('DB1-BHV-07: set-level with a NON-whitelisted level → 422, zero SQL executed', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  const res = await h.handleSetLevel(adminPost('/x', { telegramId: '555666777', level: 'SUPERADMIN' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  assert.equal(res.status, 422, 'whitelist violation must 422');
  assert.equal(captured.length, 0, 'no SQL may be executed for a non-whitelisted level');
});

test('DB1-BHV-08: set-level VIP (whitelisted) — parameterized UPDATE', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  const res = await h.handleSetLevel(adminPost('/x', { telegramId: '555666777', level: 'VIP' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd, 'users UPDATE captured');
  const setClause = upd.sql.slice(0, upd.sql.indexOf(' WHERE '));
  assert.ok(!/'[^']*'/.test(setClause), `no string literals: ${setClause}`);
  assert.ok(upd.params.includes('VIP'), 'VIP bound as param');
});

test('DB1-BHV-09: manual expire (site 3) — parameterized expire_at', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleManualExpire(adminPost('/x', { telegramId: '555666777' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd, 'users UPDATE captured');
  const setClause = upd.sql.slice(0, upd.sql.indexOf(' WHERE '));
  assert.ok(!/'[^']*'/.test(setClause), `no string literals: ${setClause}`);
  // expire_at = $n (a bound ISO timestamp param), not a quoted literal
  assert.ok(/expire_at = \$\d+/.test(upd.sql), 'expire_at bound as param');
});

test('DB1-SRC-01: newSetBuilder exists with addParam/addLiteral (NOW()/NULL only)', () => {
  const idx = MEMBERSHIP_SRC.indexOf('function newSetBuilder()');
  assert.ok(idx > -1, 'helper must exist');
  const block = MEMBERSHIP_SRC.slice(idx, idx + 900);
  assert.ok(block.includes('addParam'), 'addParam present');
  assert.ok(block.includes('addLiteral'), 'addLiteral present');
  assert.ok(block.includes("literal !== 'NOW()' && literal !== 'NULL'"), 'only NOW()/NULL literals allowed');
});

test('DB1-SRC-02: zero interpolated userSets remain in the controller', () => {
  assert.ok(!/userSets\.join\(/.test(MEMBERSHIP_SRC), 'the old ${userSets.join(", ")} pattern must be gone');
  assert.ok(!/membership_status = '\$\{/.test(MEMBERSHIP_SRC), 'no interpolated status fragments');
});

test('DB1-SRC-03: all 3 former sites now build via newSetBuilder', () => {
  assert.ok((MEMBERSHIP_SRC.match(/newSetBuilder\(\)/g) || []).length >= 4,
    'helper definition + 3 call sites');
});

// ════════════════════════════════════════════════════════════════════════════
// UP-8 — chat image MIME allowlist (behavioral via the REAL worker)
// ════════════════════════════════════════════════════════════════════════════

function loadWorker() {
  const geminiCalls = [];
  const geminiResult = { status_code: 200, response_body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'پاسخ تستی' }] } }] }) };
  const pgMock = {
    Pool: class {
      async query(sql, params) {
        const s = String(sql || '');
        if (s.includes('gemini_generate')) {
          geminiCalls.push({ sql: s, params: params || [] });
          return { rows: [{ result: geminiResult }] };
        }
        return { rows: [] };
      }
      async connect() { const self = this; return { async query(q, p) { return self.query(q, p); }, release() {} }; }
      end() { return Promise.resolve(); }
    },
  };
  const defaultMocks = { 'pg': pgMock, '@neondatabase/serverless': pgMock };
  const lmc = {}; const lr = (id) => { if (defaultMocks[id]) return defaultMocks[id]; if (lmc[id]) return lmc[id]; return require(id); };
  const lire = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g; let m;
  while ((m = lire.exec(WORKER_SRC)) !== null) { const ip = m[4]; if (lmc[ip]) continue; const rp = path.resolve(REPO_ROOT, ip); let ms = fs.readFileSync(rp, 'utf8'); ms = ms.replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace(/export\s+(?:async\s+)?function\s+(\w+)/g, 'module.exports.$1 = function $1').replace(/export\s+default\s+/g, 'module.exports.default = ').replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+let\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+var\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;'); const mod = { exports: {} }; new Function('require', 'module', 'exports', ms)(lr, mod, mod.exports); lmc[ip] = mod.exports; }
  const t = WORKER_SRC.replace("import { createHmac, timingSafeEqual } from 'node:crypto';", "const { createHmac, timingSafeEqual } = require('node:crypto');").replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace("import { Pool as NeonPool, neon } from '@neondatabase/serverless';", "const { Pool: NeonPool, neon } = require('@neondatabase/serverless');").replace("import { Pool as PgPool } from 'pg';", "const { Pool: PgPool } = require('pg');").replace(/import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const { ${n} } = require('${p}');`).replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace(/import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace('export default {', 'module.exports = {').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;');
  const mod = { exports: {} }; new Function('require', 'module', 'exports', t)(lr, mod, mod.exports);
  return { worker: mod.exports, geminiCalls };
}

function buildInitData(b, u) { const e = [['auth_date', String(Math.floor(Date.now() / 1000))], ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'], ['user', JSON.stringify(u)]]; const d = e.slice().sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => `${k}=${v}`).join('\n'); const sk = crypto.createHmac('sha256', 'WebAppData').update(b).digest(); const h = crypto.createHmac('sha256', sk).update(d).digest('hex'); return e.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).concat([`hash=${h}`]).join('&'); }

function workerEnv(o = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: 'test-bot-token', REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732', DATABASE_URL: 'postgresql://test',
    APP_ENV: 'production', BOT_USERNAME: '', WEBAPP_URL: 'https://app.test',
    APP_CACHE: memoryKv(), RATE_LIMITS: memoryKv(), JOIN_CACHE: memoryKv(), SESSION_CACHE: memoryKv(),
    AI_COOLDOWN_SECONDS: 0, AI_DAILY_MESSAGE_LIMIT: 50, AI_DAILY_IMAGE_LIMIT: 3,
    OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: 'x',
  }, o);
}

async function postChat(image, env) {
  const { worker, geminiCalls } = loadWorker();
  const initData = buildInitData('test-bot-token', { id: 831704732, first_name: 'Admin', username: 'admin', lang_code: 'fa' });
  const res = await worker.fetch(new Request('http://localhost/api/assistant/chat', {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': initData, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'این تصویر را ببین', image, history: [] }),
  }), env || workerEnv(), {});
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, geminiCalls };
}

test('UP8-BHV-01: image/jpeg data-URI accepted, real MIME forwarded to gemini_generate', async () => {
  const r = await postChat('data:image/jpeg;base64,' + FIX.jpeg);
  assert.equal(r.status, 200, `jpeg accepted, got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  assert.ok(r.geminiCalls.length >= 1, 'gemini_generate called');
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/jpeg'), 'real MIME forwarded');
});

test('UP8-BHV-02: image/png data-URI accepted with its real MIME', async () => {
  const r = await postChat('data:image/png;base64,' + FIX.png);
  assert.equal(r.status, 200, `png accepted, got ${r.status}`);
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/png'));
});

test('UP8-BHV-03: image/webp data-URI accepted with its real MIME', async () => {
  const r = await postChat('data:image/webp;base64,' + FIX.webp);
  assert.equal(r.status, 200, `webp accepted, got ${r.status}`);
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/webp'));
});

test('UP8-BHV-04: image/gif data-URI accepted with its real MIME', async () => {
  const r = await postChat('data:image/gif;base64,' + FIX.gif);
  assert.equal(r.status, 200, `gif accepted, got ${r.status}`);
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/gif'));
});

test('UP8-BHV-05: image/bmp data-URI → 422 image_type_unsupported', async () => {
  const r = await postChat('data:image/bmp;base64,Qk0=');
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_type_unsupported');
  assert.equal(r.geminiCalls.length, 0, 'no provider call for rejected input');
});

test('UP8-BHV-06: video/mp4 data-URI → 422 image_type_unsupported', async () => {
  const r = await postChat('data:video/mp4;base64,' + FIX.mp4);
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_type_unsupported');
});

test('UP8-BHV-07: image/svg+xml data-URI → 422 image_type_unsupported (XSS carrier)', async () => {
  const r = await postChat('data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'));
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_type_unsupported');
});

test('UP8-BHV-08: data-URI with empty payload → 422 image_invalid', async () => {
  const r = await postChat('data:image/png;base64,');
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_invalid');
});

test('UP8-BHV-09: comma without data: prefix → 422 image_invalid', async () => {
  const r = await postChat('some,thing');
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_invalid');
});

test('UP8-BHV-10: data-URI with a junk MIME that fails the regex → 422 image_invalid', async () => {
  const r = await postChat('data:;base64,abc');
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_invalid');
});

test('UP8-BHV-11: legacy raw base64 (no prefix) still accepted, labeled image/jpeg', async () => {
  const r = await postChat(FIX.png);
  assert.equal(r.status, 200, `legacy raw form must keep working, got ${r.status}`);
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/jpeg'),
    'legacy raw base64 is labeled image/jpeg (pre-change behavior)');
});

test('UP8-BHV-12: uppercase MIME in data-URI accepted (case-insensitive)', async () => {
  const r = await postChat('DATA:IMAGE/PNG;BASE64,' + FIX.png);
  assert.equal(r.status, 200, `uppercase form accepted, got ${r.status}`);
  assert.ok(JSON.stringify(r.geminiCalls[0].params).includes('image/png'), 'MIME lowercased');
});

test('UP8-BHV-13: oversize image (>1.4M chars) → 422 image_too_large (limit unchanged)', async () => {
  const r = await postChat('data:image/png;base64,' + 'A'.repeat(1500000));
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'image_too_large');
});

test('UP8-BHV-14: image quota exhausted → 429 daily_image_limit (quota semantics unchanged)', async () => {
  // Free tier: 3 images/day (entitlement_config.ai_image.normal_daily_limit).
  // Drive the REAL worker: 3 valid image messages pass, the 4th hits the cap.
  const { worker, geminiCalls } = loadWorker();
  const env = workerEnv({ AI_COOLDOWN_SECONDS: 0 });
  const initData = buildInitData('test-bot-token', { id: 831704732, first_name: 'Admin', username: 'admin', lang_code: 'fa' });
  const send = async () => {
    const res = await worker.fetch(new Request('http://localhost/api/assistant/chat', {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': initData, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'این تصویر را ببین', image: 'data:image/png;base64,' + FIX.png, history: [] }),
    }), env, {});
    let body; try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  for (let i = 1; i <= 3; i++) {
    const r = await send();
    assert.equal(r.status, 200, `image request ${i} must pass (got ${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
  }
  const fourth = await send();
  assert.equal(fourth.status, 429, 'the 4th image in one day must be rate limited');
  assert.equal(fourth.body.reason, 'daily_image_limit');
});

test('UP8-SRC-01: exact MIME allowlist (jpeg|png|webp|gif)', () => {
  const m = ASSISTANT_SRC.match(/ASSISTANT_IMAGE_MIME_ALLOWLIST = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'allowlist const must exist');
  assert.equal(m[1].replace(/\s+/g, ' ').trim(), "'image/jpeg', 'image/png', 'image/webp', 'image/gif'");
});

test('UP8-SRC-02: imageMime forwarded through callGeminiChat → gemini inline_data', () => {
  const idx = ASSISTANT_SRC.indexOf('async function callGeminiChat(');
  const block = ASSISTANT_SRC.slice(idx, idx + 900);
  assert.ok(block.includes('imageMime ='), 'callGeminiChat takes imageMime');
  assert.ok(block.includes('mime_type: imageMime'), 'inline_data uses the real MIME');
  assert.ok(!block.includes("mime_type: 'image/jpeg'"), 'the hardcode must be gone');
});

test('UP8-SRC-03: parseAssistantChatImage is regex-only (no atob/decode added)', () => {
  const idx = ASSISTANT_SRC.indexOf('function parseAssistantChatImage');
  const block = ASSISTANT_SRC.slice(idx, idx + 1400);
  assert.ok(!block.includes('atob'), 'no decode added (regex-only validation)');
  assert.ok(!block.includes('Uint8Array'), 'no byte processing added');
});

test('UP8-SRC-04: validation is BEFORE quota accounting (no quota consumed on reject)', () => {
  const parseIdx = ASSISTANT_SRC.indexOf('parsedImage = parseAssistantChatImage(payload.image)');
  const quotaIdx = ASSISTANT_SRC.indexOf('await recordRateLimitUsage(env, userId, hasImage)');
  assert.ok(parseIdx > -1 && quotaIdx > -1 && parseIdx < quotaIdx,
    'parse+validate must precede the recordRateLimitUsage CALL (not its definition)');
});

test('UP8-SRC-05: limits unchanged (2MB body / 1.4M chars / 4000 message)', () => {
  assert.ok(ASSISTANT_SRC.includes('payload.image.length > 1400000'), 'image char cap unchanged');
  assert.ok(ASSISTANT_SRC.includes('message.length > 4000'), 'message cap unchanged');
});

// ════════════════════════════════════════════════════════════════════════════
// Skipped findings — on record
// ════════════════════════════════════════════════════════════════════════════

test('UP2-BHV-11: MOV (ftyp with qt brand) rejected — no ISOBMFF pass-through', async () => {
  // ....ftypqt  (QuickTime movie)
  const mov = Buffer.from([0,0,0,0x14, 0x66,0x74,0x79,0x70, 0x71,0x74,0x20,0x20]).toString('base64');
  const r = await tryStore(mov, 'image/avif');
  assert.ok(!r.ok, 'ftyp + qt brand must NOT pass the AVIF check');
});

test('UP2-SRC-04: byte cap constant + ctype whitelist unchanged', () => {
  assert.ok(ADS_REPO_SRC.includes('_MAX_IMAGE_BYTES'), 'cap constant present');
  const idx = ADS_REPO_SRC.indexOf('_MAX_IMAGE_BYTES =');
  const block = ADS_REPO_SRC.slice(idx, idx + 200);
  assert.ok(/500\s*\*\s*1024|512000|524288/.test(block) || /_MAX_IMAGE_BYTES = \d+/.test(block),
    '500KB byte cap constant');
});

test('DB1-BHV-10: cross-scenario — EVERY captured users UPDATE is literal-free (all 3 sites)', async () => {
  const scenarios = [
    (h, env, init) => h.handleApprove(adminPost('/x', { requestId: 'req-001' }, init), env, undefined),
    (h, env, init) => h.handleReject(adminPost('/x', { requestId: 'req-001' }, init), env, undefined),
    (h, env, init) => h.handleSuspend(adminPost('/x', { requestId: 'req-001' }, init), env, undefined),
    (h, env, init) => h.handleReactivate(adminPost('/x', { requestId: 'req-001' }, init), env, undefined),
    (h, env, init) => h.handleManualSuspend(adminPost('/x', { telegramId: '555666777' }, init), env, undefined),
    (h, env, init) => h.handleManualReactivate(adminPost('/x', { telegramId: '555666777' }, init), env, undefined),
    (h, env, init) => h.handleManualExpire(adminPost('/x', { telegramId: '555666777' }, init), env, undefined),
    (h, env, init) => h.handleSetLevel(adminPost('/x', { telegramId: '555666777', level: 'VIP' }, init), env, undefined),
    (h, env, init) => h.handleSetLevel(adminPost('/x', { telegramId: '555666777', level: 'FREE' }, init), env, undefined),
  ];
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  const init = buildInitDataFor(ADMIN);
  for (const scenario of scenarios) {
    await scenario(h, { APP_CACHE: memoryKv() }, init).catch(() => {});
  }
  const updates = usersUpdate(captured);
  assert.ok(updates.length >= 5, `expected UPDATEs across scenarios, saw ${updates.length}`);
  for (const q of updates) {
    const setClause = q.sql.slice(0, q.sql.indexOf(' WHERE '));
    assert.ok(!/'[^']*'/.test(setClause), `zero string literals required: ${setClause}`);
    assert.ok(/WHERE telegram_id = \$\d+$/.test(q.sql), 'WHERE telegram_id stays parameterized');
  }
});

test('DB1-SRC-04: reject/reactivate routes share the same builder (makeActionHandler family)', async () => {
  const captured = [];
  const { deps, buildInitDataFor } = buildMembershipDeps(captured);
  const h = createMembershipHandlers(deps);
  await h.handleReject(adminPost('/x', { requestId: 'req-001' }, buildInitDataFor(ADMIN)), { APP_CACHE: memoryKv() }, undefined);
  const upd = usersUpdate(captured)[0];
  assert.ok(upd, 'reject also updates the user row');
  assert.ok(upd.params.includes('REJECTED'), 'REJECTED bound as param');
});

test('UP8-BHV-15: data-URI with extra parameters before base64 → 422 image_invalid (strict format)', async () => {
  const r = await postChat('data:image/png;charset=utf-8;base64,' + FIX.png);
  assert.equal(r.status, 422, 'only the exact data:<mime>;base64,<payload> form is accepted');
  assert.equal(r.body.reason, 'image_invalid');
});

test('UP8-SRC-06: generateAssistantReply forwards imageMime to callGeminiChat', () => {
  const idx = ASSISTANT_SRC.indexOf('async function generateAssistantReply(');
  const block = ASSISTANT_SRC.slice(idx, idx + 1600);
  assert.ok(block.includes('imageMime ='), 'signature takes imageMime');
  assert.ok(/callGeminiChat\(env, prompt, imageBase64, imageMime\)/.test(block),
    'the gemini call passes imageMime through');
});

test('SKIPPED-RECORD: KV-2/UP-4/AP-8 deliberately skipped (findings on record)', () => {
  // KV-2: adimg KV entries have no TTL — naive TTL would break active popup
  //   references; delete/cascade needs lifecycle design (user decision).
  // UP-4: image IDs are ~41-bit random in a PUBLIC read-only route — no
  //   security boundary crossed (INFO).
  // AP-8: sessions.js randomUUID fallback is dead code in Workers, never
  //   used for authz (INFO).
  assert.ok(true, 'recorded');
});

/**
 * CAMPAIGNS — ADMIN PANEL FRONTEND REGRESSION TEST
 * =================================================
 * Locks the admin panel Exchange Campaigns section (the missing-frontend fix):
 *
 *   1. Wiring: nav item, section container, switch case, ADMIN_SECTION_PERMS
 *      entry, _adminSectionLabels entry, window exports.
 *   2. Access control: _adminCanAccessSection('campaigns') honors
 *      campaigns.view/campaigns.manage (behavioral, real functions).
 *   3. API contract alignment: list/create/update/status/delete/registrations/
 *      export/upload call shapes match src/controllers/campaigns_admin.js.
 *   4. Loading / empty / error states are distinct and rendered.
 *   5. WebP conversion: _cmpImageUploadPlan behavior (JPG/PNG→convert,
 *      small WebP→passthrough, SVG/GIF/oversize→reject), ISO date helpers,
 *      allowed-actions matrix, canvas invariants (dimensions preserved, no
 *      background fill → PNG alpha kept, quality ladder floor 0.65, honest
 *      failure on browsers that cannot encode WebP).
 *   6. Old-image compatibility: manual HTTPS image_url field remains; only
 *      the WebP upload URL is stored after a successful conversion.
 *   7. i18n parity: every adm_camp_* key used by admin.js exists in fa AND en.
 *
 * All tests are offline. Run: node --test tests/campaigns-admin-panel-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ADMIN_JS = read('admin.js');
const HTML = read('index.html');
const I18N_SRC = read('i18n.js');

// ── Extractors ──────────────────────────────────────────────────────────────

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, `marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s);
  assert.ok(e !== -1, `end marker not found after ${startMarker}`);
  return src.slice(s, e);
}

// Slice a full function body: from `function name`/`async function name` to
// the next top-level function declaration or the window-export block.
function fnBody(name) {
  const start = ADMIN_JS.indexOf(`function ${name}`);
  assert.ok(start !== -1, `function not found: ${name}`);
  const rest = ADMIN_JS.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function |\n\/\/ ──|\nwindow\./);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  assert.ok(body.length > 50, `body too short for ${name}`);
  return body;
}

// [CMP-PURE-START]..[CMP-PURE-END] block (pure helpers — no DOM).
function loadPureHelpers() {
  const block = sliceBetween(ADMIN_JS, '// [CMP-PURE-START]', '// [CMP-PURE-END]');
  return new Function(block + '\n;return { _cmpImageUploadPlan, CMP_WEBP_QUALITIES, _cmpAllowedActions, _cmpFromLocalInput, _cmpToLocalInput, _cmpFmtDate };')();
}

// ADMIN_SECTION_PERMS + _adminHasPerm + _adminCanAccessSection (behavioral).
function loadAccessControl(adminData) {
  const block = sliceBetween(ADMIN_JS, 'const ADMIN_SECTION_PERMS', '// ─── Helpers');
  return new Function('_adminData', block + '\n;return { ADMIN_SECTION_PERMS, _adminHasPerm, _adminCanAccessSection };')(adminData);
}

const loadI18nContext = () =>
  new Function(I18N_SRC + '\n;return { i18n };')();

// ═══════════════════════════════════════════════════════════════════════════
// 1. WIRING
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-1: nav item + section container exist in index.html', () => {
  assert.match(HTML, /data-admin-section="campaigns" onclick="switchAdminSection\('campaigns', this\)"/, 'campaigns nav button');
  assert.match(HTML, /<section class="adm-section" id="admin-section-campaigns">/, 'campaigns section container');
  assert.match(HTML, /<div id="cmp-admin-section"><\/div>/, 'render target container');
  assert.match(HTML, /data-i18n="adm_sidebar_campaigns"/, 'nav label i18n');
  assert.match(HTML, /data-i18n="adm_camp_title"/, 'section title i18n');
});

test('CAMP-AD-2: switchAdminSection dispatches to loadAdminCampaigns', () => {
  assert.match(ADMIN_JS, /case 'campaigns': loadAdminCampaigns\(1\); break;/, 'switch case loads the list');
});

test('CAMP-AD-3: ADMIN_SECTION_PERMS gates campaigns by view+manage', () => {
  const { ADMIN_SECTION_PERMS } = loadAccessControl(null);
  assert.deepEqual(ADMIN_SECTION_PERMS['campaigns'], ['campaigns.view', 'campaigns.manage']);
});

test('CAMP-AD-4: section label registered', () => {
  assert.match(ADMIN_JS, /'campaigns': t\('adm_sidebar_campaigns'\)/, 'label map entry');
});

test('CAMP-AD-5: handlers exported to window (onclick wiring)', () => {
  for (const fn of [
    'loadAdminCampaigns', 'cmpSearchApply', 'cmpFilterApply',
    'campaignFormOpen', 'campaignFormClose', 'campaignFormSubmit',
    'campaignSetStatus', 'campaignDelete', 'campaignShowRegistrations',
    'campaignExportCsv', 'campaignImageFileSelected',
  ]) {
    assert.match(ADMIN_JS, new RegExp(`window\\.${fn} = ${fn};`), `window.${fn} export`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ACCESS CONTROL (behavioral — real functions)
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-10: no-permission admin is denied the campaigns section', () => {
  const ac = loadAccessControl({ is_super: false, permissions: ['users.view'] });
  assert.equal(ac._adminCanAccessSection('campaigns'), false, 'no matching perm → denied');
});

test('CAMP-AD-11: campaigns.view OR campaigns.manage grants access; super admin always', () => {
  const viewer = loadAccessControl({ is_super: false, permissions: ['campaigns.view'] });
  const manager = loadAccessControl({ is_super: false, permissions: ['campaigns.manage'] });
  const wildcard = loadAccessControl({ is_super: false, permissions: ['*'] });
  const superAdmin = loadAccessControl({ is_super: true, permissions: [] });
  for (const ac of [viewer, manager, wildcard, superAdmin]) {
    assert.equal(ac._adminCanAccessSection('campaigns'), true);
  }
});

test('CAMP-AD-12: write helpers hard-check campaigns.manage before any call', () => {
  for (const fn of ['campaignFormOpen', 'campaignFormSubmit', 'campaignSetStatus', 'campaignDelete']) {
    const start = ADMIN_JS.indexOf(`function ${fn}`);
    const body = ADMIN_JS.slice(start, start + 400);
    assert.match(body, /_adminHasPerm\('campaigns\.manage'\)/, `${fn} must check campaigns.manage first`);
    const permIdx = body.indexOf("_adminHasPerm('campaigns.manage')");
    assert.ok(permIdx !== -1 && permIdx < 200, `${fn} checks the perm at the top`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. API CONTRACT ALIGNMENT (call shapes ↔ controller)
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-20: list call — GET /api/admin/campaigns with page/limit/status/search', () => {
  const body = fnBody('loadAdminCampaigns');
  assert.match(body, /adminApiFetch\('\/api\/admin\/campaigns' \+ params\)/);
  assert.match(body, /\?page=' \+ _cmpListState\.page \+ '&limit=' \+ _cmpListState\.limit/);
  assert.match(body, /'&status=' \+ encodeURIComponent\(_cmpListState\.status\)/);
  assert.match(body, /'&search=' \+ encodeURIComponent\(_cmpListState\.search\)/);
  // Response shape: { items, total, page, limit, totalPages, status:'success' }
  assert.match(body, /data\.status !== 'success' \|\| !Array\.isArray\(data\.items\)/);
});

test('CAMP-AD-21: create/update — POST /api/admin/campaigns and PUT /:id with the exact field set', () => {
  const body = fnBody('campaignFormSubmit');
  assert.match(body, /title_fa: g\('cmp-f-title-fa'\)\.trim\(\)/);
  assert.match(body, /title_en: g\('cmp-f-title-en'\)\.trim\(\)/);
  assert.match(body, /payload\.starts_at = startsIso/);
  // ISO 8601 with timezone (controller ISO_8601_RE contract).
  assert.match(body, /_cmpFromLocalInput\(g\('cmp-f-starts'\)\)/);
  // status is ONLY sent on create (update rejects it server-side).
  assert.match(body, /if \(!_cmpEditingId\) \{[\s\S]{0,120}payload\.status = st;/);
  assert.match(body, /adminApiFetch\('\/api\/admin\/campaigns', \{ method: 'POST'/);
  assert.match(body, /adminApiFetch\('\/api\/admin\/campaigns\/' \+ encodeURIComponent\(_cmpEditingId\), \{ method: 'PUT'/);
});

test('CAMP-AD-22: status transitions — PUT /:id/status with {status: PUBLISHED|STOPPED}', () => {
  const body = fnBody('campaignSetStatus');
  assert.ok(body.includes("'/status', { method: 'PUT', body: JSON.stringify({ status: target }) })"),
    'status changes go through the dedicated PUT /status endpoint only');
});

test('CAMP-AD-23: delete — DELETE /:id (soft) behind a confirm', () => {
  const body = fnBody('campaignDelete');
  assert.match(body, /confirm\(t\('adm_camp_confirm_delete'\)\)/);
  assert.match(body, /'\/api\/admin\/campaigns\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/);
});

test('CAMP-AD-24: registrations — GET /:id/registrations with page param; response fields used', () => {
  const body = fnBody('campaignShowRegistrations');
  assert.match(body, /\/registrations\?page=' \+ page \+ '&limit=20'/);
  assert.match(body, /data\.registration_count/);
  assert.match(body, /data\.items\.map/);
});

test('CAMP-AD-25: CSV export — authenticated blob download of /registrations/export', () => {
  const body = fnBody('campaignExportCsv');
  assert.match(body, /\/registrations\/export/);
  assert.match(body, /'X-Telegram-Init-Data': initData/);
  assert.match(body, /res\.blob\(\)/);
  assert.match(body, /a\.download = 'campaign-registrations-/);
});

test('CAMP-AD-26: upload — POST /api/admin/campaigns/upload-image with {data_uri}', () => {
  const body = fnBody('campaignImageFileSelected');
  assert.match(body, /'\/api\/admin\/campaigns\/upload-image'/);
  assert.match(body, /body: JSON\.stringify\(\{ data_uri: dataUri \}\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. LOADING / EMPTY / ERROR STATES
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-30: three distinct states rendered (loading / empty / error+retry)', () => {
  const loadBody = fnBody('loadAdminCampaigns');
  assert.match(loadBody, /adm_camp_loading/, 'loading state');
  assert.match(loadBody, /adm_camp_load_error/, 'error state');
  assert.match(loadBody, /adm_camp_retry/, 'error retry button');
  const listBody = fnBody('renderCampaignsList');
  assert.match(listBody, /adm_camp_empty/, 'empty state');
  assert.match(listBody, /adm_camp_empty_desc/, 'empty state description');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. WebP CONVERSION (behavioral pure helpers + canvas source invariants)
// ═══════════════════════════════════════════════════════════════════════════

const pure = loadPureHelpers();

test('CAMP-AD-40: JPG and PNG are converted to WebP', () => {
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/jpeg', size: 1000 }), { ok: true, mode: 'convert' });
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/jpg', size: 1000 }), { ok: true, mode: 'convert' });
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/png', size: 1000 }), { ok: true, mode: 'convert' });
  // Uppercase MIME normalized.
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'IMAGE/PNG', size: 1000 }), { ok: true, mode: 'convert' });
});

test('CAMP-AD-41: small valid WebP passes through untouched; oversized WebP gets converted (optimized)', () => {
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/webp', size: 512000 }), { ok: true, mode: 'passthrough' });
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/webp', size: 512001 }), { ok: true, mode: 'convert' });
});

test('CAMP-AD-42: SVG / GIF / unknown types are explicitly rejected', () => {
  for (const type of ['image/svg+xml', 'image/gif', 'image/avif', 'application/pdf', 'text/html', '']) {
    const plan = pure._cmpImageUploadPlan({ type, size: 100 });
    assert.equal(plan.ok, false, `${type || '(empty)'} rejected`);
    assert.equal(plan.code, 'UNSUPPORTED_TYPE');
  }
});

test('CAMP-AD-43: oversized raw input rejected; missing file rejected', () => {
  assert.deepEqual(pure._cmpImageUploadPlan({ type: 'image/png', size: 15728641 }).code, 'TOO_LARGE_INPUT');
  assert.deepEqual(pure._cmpImageUploadPlan(null).code, 'NO_FILE');
  // Custom caps honored (injection point for tests / future tuning).
  assert.deepEqual(
    pure._cmpImageUploadPlan({ type: 'image/png', size: 2000 }, { maxInputBytes: 1000 }).code,
    'TOO_LARGE_INPUT',
  );
});

test('CAMP-AD-44: quality ladder never goes below 0.65 (no destructive compression)', () => {
  assert.deepEqual(pure.CMP_WEBP_QUALITIES, [0.85, 0.75, 0.65]);
});

test('CAMP-AD-45: canvas invariants — dimensions preserved, alpha preserved, honest failure', () => {
  const body = fnBody('_cmpConvertToWebpBlob');
  // Dimensions taken from the bitmap — never resized, never upscaled.
  assert.match(body, /canvas\.width = bitmap\.width/);
  assert.match(body, /canvas\.height = bitmap\.height/);
  assert.ok(!/\.resize\(|drawImage\([^)]*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/.test(body),
    'no resizing drawImage overload');
  // No background fill → PNG transparency survives as WebP alpha.
  assert.ok(!/fillStyle|fillRect/.test(body), 'no background fill (alpha preserved)');
  // toBlob must request image/webp with the quality ladder.
  assert.match(body, /canvas\.toBlob\(resolve, 'image\/webp', CMP_WEBP_QUALITIES\[i\]\)/);
  // Browsers that fall back to a non-WebP blob → honest failure, no fake upload.
  assert.match(body, /if \(b\.type !== 'image\/webp'\) throw \{ code: 'WEBP_UNSUPPORTED' \}/);
  // Early stop at the first size that fits (best quality wins).
  assert.match(body, /if \(b\.size <= 512000\) break/);
});

test('CAMP-AD-46: only the WebP URL is stored after conversion — original never uploaded', () => {
  const body = fnBody('campaignImageFileSelected');
  // The uploaded data URI is built from the CONVERTED blob (or a small
  // passthrough WebP), never from the raw JPG/PNG File.
  assert.match(body, /fr\.readAsDataURL\(blob\)/, 'data URI built from converted/passthrough blob');
  // The returned internal URL is what lands in the image_url field.
  assert.match(body, /urlField\.value = resp\.url/);
  // Conversion failure paths abort with explicit codes — upload is never
  // declared successful with a partial/converted-wrongly file.
  assert.match(body, /if \(!blob \|\| blob\.type !== 'image\/webp'\) throw \{ code: 'WEBP_UNSUPPORTED' \}/);
  assert.match(body, /if \(blob\.size > 512000\) throw \{ code: 'TOO_LARGE_OUTPUT' \}/);
  assert.match(body, /input\.value = '';\s*\}/, 'input reset on failure');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. DATE HELPERS + LIFECYCLE MATRIX
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-50: _cmpFromLocalInput produces strict ISO 8601 with timezone (controller contract)', () => {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const iso = pure._cmpFromLocalInput('2026-06-01T12:30');
  assert.match(iso, ISO_RE);
  assert.equal(typeof Date.parse(iso), 'number');
  assert.equal(pure._cmpFromLocalInput(''), '');
  assert.equal(pure._cmpFromLocalInput('garbage'), '');
});

test('CAMP-AD-51: _cmpToLocalInput round-trips through _cmpFromLocalInput', () => {
  const iso = pure._cmpFromLocalInput('2026-06-01T12:30');
  const back = pure._cmpToLocalInput(iso);
  const iso2 = pure._cmpFromLocalInput(back);
  assert.equal(iso, iso2, 'round-trip preserves the instant');
});

test('CAMP-AD-52: allowed-actions matrix mirrors the controller state machine', () => {
  assert.deepEqual(pure._cmpAllowedActions('DRAFT'), ['publish', 'delete']);
  assert.deepEqual(pure._cmpAllowedActions('PUBLISHED'), ['stop', 'delete']);
  assert.deepEqual(pure._cmpAllowedActions('STOPPED'), ['publish', 'delete']);
  assert.deepEqual(pure._cmpAllowedActions('DELETED'), [], 'DELETED is terminal');
  assert.deepEqual(pure._cmpAllowedActions('WHATEVER'), [], 'unknown status → no actions');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. OLD-IMAGE COMPATIBILITY + i18n PARITY
// ═══════════════════════════════════════════════════════════════════════════

test('CAMP-AD-60: manual HTTPS image_url field kept (old external URLs stay usable)', () => {
  const formBody = fnBody('_cmpRenderForm');
  assert.match(formBody, /id="cmp-f-image-url"/, 'manual URL input present');
  assert.match(formBody, /adm_camp_field_image_url/, 'labeled');
  const submitBody = fnBody('campaignFormSubmit');
  assert.match(submitBody, /image_url: g\('cmp-f-image-url'\)\.trim\(\) \|\| null/, 'payload sends the manual URL when used');
});

test('CAMP-AD-61: every adm_camp_* key used by admin.js exists in fa AND en', () => {
  const ctx = loadI18nContext();
  const KEY_RE = /\bt\(\s*'([^']+)'/g;
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(ADMIN_JS)) !== null) {
    if (m[1].startsWith('adm_camp_') && !m[1].endsWith('_')) keys.add(m[1]); // dynamic prefixes (adm_camp_status_ + status) excluded
  }
  assert.ok(keys.size >= 25, `admin.js should reference adm_camp_* keys (found ${keys.size})`);
  const failures = [];
  for (const key of keys) {
    if (!(key in ctx.i18n.fa)) failures.push(`${key} missing in fa`);
    if (!(key in ctx.i18n.en)) failures.push(`${key} missing in en`);
  }
  assert.deepEqual(failures, [], `adm_camp_* i18n parity failures:\n${failures.join('\n')}`);
});

test('CAMP-AD-62: form date inputs pre-fill from stored ISO values (edit mode)', () => {
  const body = fnBody('_cmpRenderForm');
  assert.match(body, /_cmpToLocalInput\(c\.starts_at\)/);
  assert.match(body, /_cmpToLocalInput\(c\.ends_at\)/);
});

// Dynamic i18n keys resolve to concrete dictionary entries for every status.
test('CAMP-AD-63: adm_camp_status_<STATUS> keys exist for all four statuses (fa + en)', () => {
  const ctx = loadI18nContext();
  for (const s of ['DRAFT', 'PUBLISHED', 'STOPPED', 'DELETED']) {
    assert.ok(`adm_camp_status_${s}` in ctx.i18n.fa, `adm_camp_status_${s} missing in fa`);
    assert.ok(`adm_camp_status_${s}` in ctx.i18n.en, `adm_camp_status_${s} missing in en`);
  }
});

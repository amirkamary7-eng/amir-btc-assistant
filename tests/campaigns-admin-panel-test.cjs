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
 *   8. Single-field content (Problem C): _cmpDetectLang language detection,
 *      _cmpBuildContentPayload derivation (original stored in its language,
 *      optional manual translation in the other, NO fake translation),
 *      _cmpAdminImgUrl internal-URL resolution for previews.
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
  return new Function(block + '\n;return { _cmpImageUploadPlan, CMP_WEBP_QUALITIES, _cmpAllowedActions, _cmpFromLocalInput, _cmpToLocalInput, _cmpFmtDate, _cmpDetectLang, _cmpPanelLang, _cmpAdminImgUrl, _cmpBuildContentPayload, _cmpIsValidRegUrl };')();
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
  // Single-field form (Problem C): ONE title/summary/body set; the bilingual
  // payload is derived from the detected language + optional translation.
  assert.match(body, /var title = g\('cmp-f-title'\)\.trim\(\)/, 'single title field');
  assert.match(body, /_cmpBuildContentPayload\(/, 'payload built by the pure content builder');
  assert.match(body, /g\('cmp-f-tr-title'\)\.trim\(\)/, 'optional translation title read');
  assert.match(body, /payload\.starts_at = startsIso/);
  // ISO 8601 with timezone (controller ISO_8601_RE contract).
  assert.match(body, /_cmpFromLocalInput\(g\('cmp-f-starts'\)\)/);
  // Required-field validation marks the invalid input visibly.
  assert.match(body, /_cmpMarkInvalid\('cmp-f-title'\)/, 'title required + marked');
  assert.match(body, /_cmpMarkInvalid\('cmp-f-starts'\)/, 'starts required + marked');
  // Save state: button disabled + relabeled while in-flight.
  assert.match(body, /saveBtn\.disabled = true; saveBtn\.textContent = t\('adm_camp_saving'\)/, 'in-flight save state');
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
  assert.match(formBody, /adm_camp_advanced_url/, 'labeled as the advanced URL section');
  const submitBody = fnBody('campaignFormSubmit');
  assert.match(submitBody, /payload\.image_url = g\('cmp-f-image-url'\)\.trim\(\) \|\| null;/, 'payload sends the manual URL when used');
});

test('CAMP-AD-64: premium grouped form structure (adm-form-card + semantic groups)', () => {
  const formBody = fnBody('_cmpRenderForm');
  assert.match(formBody, /adm-form-card cmp-adm-form/, 'premium form card');
  for (const g of ['adm_camp_g_basic', 'adm_camp_g_schedule', 'adm_camp_g_image', 'adm_camp_g_publish']) {
    assert.match(formBody, new RegExp(g), `group ${g}`);
  }
  // Responsive rows wrap (no overflow on mobile).
  assert.match(formBody, /cmp-adm-row2/, 'responsive row class used');
  // Image preview resolves internal URLs against the API base.
  assert.match(formBody, /_cmpAdminImgUrl\(c\.image_url\)/, 'preview URL resolved');
  // WebP upload input wired.
  assert.match(formBody, /campaignImageFileSelected\(this\)/, 'upload onchange wired');
});

test('CAMP-AD-65: manual translation section is optional and collapsible', () => {
  const formBody = fnBody('_cmpRenderForm');
  assert.match(formBody, /id="cmp-f-translation"/, 'translation details section');
  assert.match(formBody, /adm_camp_g_translation/, 'translation group label');
  assert.match(formBody, /adm_camp_tr_hint/, 'honest fallback hint (no fake translation)');
  for (const id of ['cmp-f-tr-title', 'cmp-f-tr-summary', 'cmp-f-tr-body']) {
    assert.match(formBody, new RegExp(`id="${id}"`), `translation field ${id}`);
  }
  // Auto-expanded ONLY when the other language already holds a different text
  // (legacy bilingual campaigns keep both versions visible/editable).
  assert.match(formBody, /hasTr \? ' open' : ''/, 'details open state driven by existing translation');
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


// ═════════════════════════════════════════════════════════════════════════
// 8. SINGLE-FIELD CONTENT (Problem C — behavioral, real pure helpers)
// ═════════════════════════════════════════════════════════════════════════

test('CAMP-AD-70: _cmpDetectLang — Persian ratio detection (fa/en/mixed/empty)', () => {
  assert.equal(pure._cmpDetectLang('کمپین ویژه صرافی'), 'fa', 'pure Persian');
  assert.equal(pure._cmpDetectLang('Special BTC reward campaign'), 'en', 'pure English');
  assert.equal(pure._cmpDetectLang('جوایز BTC ویژه'), 'fa', 'Persian with a ticker symbol');
  assert.equal(pure._cmpDetectLang(''), 'fa', 'empty defaults to fa (app primary language)');
  assert.equal(pure._cmpDetectLang(null), 'fa', 'null-safe');
  assert.equal(pure._cmpDetectLang(undefined), 'fa', 'undefined-safe');
  // A mostly-English text with a few Persian letters stays English.
  assert.equal(pure._cmpDetectLang('Join now and win جایزه big rewards today'), 'en');
});

test('CAMP-AD-71: _cmpBuildContentPayload — original stored in its language, no fake translation', () => {
  // Persian main text, NO translation: fa column gets the original; en title
  // copies the original (NOT NULL) so English users see the SAME original
  // text via the display fallback — never a fabricated translation.
  const p1 = pure._cmpBuildContentPayload('کمپین تست', 'خلاصه تست', 'متن تست', '', '', '');
  assert.equal(p1.title_fa, 'کمپین تست');
  assert.equal(p1.title_en, 'کمپین تست', 'no translation → original shown for both (honest fallback)');
  assert.equal(p1.summary_fa, 'خلاصه تست');
  assert.equal(p1.summary_en, null, 'no fake English summary');
  assert.equal(p1.body_fa, 'متن تست');
  assert.equal(p1.body_en, '', 'empty other body → display falls back to the original');

  // English main text, no translation: mirrored.
  const p2 = pure._cmpBuildContentPayload('Test campaign', 'Test summary', 'Test body', '', '', '');
  assert.equal(p2.title_en, 'Test campaign');
  assert.equal(p2.title_fa, 'Test campaign', 'no translation → original shown for both');
  assert.equal(p2.summary_en, 'Test summary');
  assert.equal(p2.summary_fa, null);

  // WITH a manual translation: the other language stores the translation.
  const p3 = pure._cmpBuildContentPayload('کمپین تست', 'خلاصه', 'متن', 'Test campaign', 'Summary', 'Body');
  assert.equal(p3.title_fa, 'کمپین تست', 'original preserved');
  assert.equal(p3.title_en, 'Test campaign', 'manual translation stored');
  assert.equal(p3.body_en, 'Body');
  assert.equal(p3.summary_en, 'Summary');
});

test('CAMP-AD-72: _cmpPanelLang — admin panel language (default fa)', () => {
  assert.equal(pure._cmpPanelLang(), 'fa', 'defaults to fa outside a window context');
});

test('CAMP-AD-73: _cmpAdminImgUrl — internal URLs prefixed, external untouched', () => {
  assert.equal(pure._cmpAdminImgUrl('https://cdn.example.com/x.webp'), 'https://cdn.example.com/x.webp', 'external untouched');
  assert.equal(pure._cmpAdminImgUrl('/api/advertisements/image/img_abc123'), '/api/advertisements/image/img_abc123', 'no API_BASE → relative kept as-is');
  assert.equal(pure._cmpAdminImgUrl(''), '', 'empty safe');
  assert.equal(pure._cmpAdminImgUrl(null), null, 'null safe');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. REGISTRATION LINK + REDESIGNED TOOLBAR (P0/P1 — this PR)
// ═══════════════════════════════════════════════════════════════════════════

// The pure-helper block must expose the new validator for these tests.
// (loadPureHelpers extracts [CMP-PURE-START]..[CMP-PURE-END].)
test('CAMP-AD-80: _cmpIsValidRegUrl — http(s) only, no credentials/localhost/IP literals, null-safe', () => {
  const h = loadPureHelpers();
  // Valid destinations.
  assert.equal(h._cmpIsValidRegUrl('https://exchange.example.com/register?vip=AMIRBTC'), true, 'https with query');
  assert.equal(h._cmpIsValidRegUrl('http://example.org/join'), true, 'plain http allowed (matches server policy)');
  assert.equal(h._cmpIsValidRegUrl('  https://pad.example.com/signup  '), true, 'whitespace tolerated (trimmed)');
  // Dangerous schemes — structurally rejected.
  assert.equal(h._cmpIsValidRegUrl('javascript:alert(document.domain)'), false, 'javascript: rejected');
  assert.equal(h._cmpIsValidRegUrl('data:text/html,<script>alert(1)</script>'), false, 'data: rejected');
  assert.equal(h._cmpIsValidRegUrl('vbscript:msgbox(1)'), false, 'vbscript: rejected');
  assert.equal(h._cmpIsValidRegUrl('file:///etc/passwd'), false, 'file: rejected');
  assert.equal(h._cmpIsValidRegUrl('intent://x/#Intent'), false, 'intent: rejected');
  assert.equal(h._cmpIsValidRegUrl('HTTPS://exchange.example.com'), true, 'scheme case-insensitive');
  // Credentials / internal hosts.
  assert.equal(h._cmpIsValidRegUrl('https://user:pass@exchange.example.com/register'), false, 'embedded credentials rejected');
  assert.equal(h._cmpIsValidRegUrl('http://localhost/x'), false, 'localhost rejected');
  assert.equal(h._cmpIsValidRegUrl('http://127.0.0.1/x'), false, 'IPv4 literal rejected');
  assert.equal(h._cmpIsValidRegUrl('http://[::1]/x'), false, 'IPv6 literal rejected');
  // Malformed / null-safe.
  assert.equal(h._cmpIsValidRegUrl(''), false, 'empty');
  assert.equal(h._cmpIsValidRegUrl('not a url'), false, 'garbage');
  assert.equal(h._cmpIsValidRegUrl(null), false, 'null');
  assert.equal(h._cmpIsValidRegUrl(undefined), false, 'undefined');
  assert.equal(h._cmpIsValidRegUrl(12345), false, 'non-string');
  assert.equal(h._cmpIsValidRegUrl('https://x.example/' + 'a'.repeat(2100)), false, 'length-bounded (2048)');
});

test('CAMP-AD-81: registration URL field exists in create AND edit forms with stored-value prefill', () => {
  const formBody = fnBody('_cmpRenderForm');
  assert.match(formBody, /id="cmp-f-reg-url"/, 'the registration URL input');
  assert.match(formBody, /adm_camp_g_registration/, 'its group label key');
  assert.match(formBody, /c\.registration_url \|\| ''/, 'edit mode prefills the STORED value');
  assert.match(formBody, /maxlength="2048"/, 'client length bound');
});

test('CAMP-AD-82: campaignFormSubmit validates and sends registration_url (client mirror of the server validator)', () => {
  const body = fnBody('campaignFormSubmit');
  assert.match(body, /_cmpIsValidRegUrl\(regUrl\)/, 'client-side validation before send');
  assert.match(body, /_cmpMarkInvalid\('cmp-f-reg-url'\)/, 'visible invalid state');
  assert.match(body, /payload\.registration_url = regUrl \|\| null/, 'explicit clear when empty (never an accidental stale link)');
});

test('CAMP-AD-83: redesigned toolbar — chips + search + count + reset, no native select, mobile-safe classes', () => {
  const body = fnBody('renderCampaignsToolbar');
  assert.match(body, /cmp-adm-toolbar/, 'toolbar container');
  assert.match(body, /adm-filter-btn/, 'reuses the panel chip token');
  assert.match(body, /cmp-adm-search-input/, 'search input');
  assert.match(body, /cmp-adm-search-clear/, 'clear (×) affordance');
  assert.match(body, /cmp-adm-count/, 'real result count badge');
  assert.match(body, /cmp-adm-reset/, 'explicit reset-to-All affordance');
  assert.match(body, /cmpFilterApply/, 'status chips dispatch through cmpFilterApply');
  assert.ok(!body.includes('<select'), 'the unstyled native select is gone');
  assert.ok(!body.includes('style="flex:1;min-width:160px"'), 'no inline layout styles remain');
  // The API contract is unchanged: same query params as before.
  const load = fnBody('loadAdminCampaigns');
  assert.match(load, /'\?page=' \+ _cmpListState\.page/, 'page param still sent');
  assert.match(load, /'&limit=' \+ _cmpListState\.limit/, 'limit param still sent');
  assert.match(load, /'&status=' \+ encodeURIComponent/, 'status param still sent');
  assert.match(load, /'&search=' \+ encodeURIComponent/, 'search param still sent');
});

test('CAMP-AD-84: new toolbar/export handlers wired to window (onclick contract)', () => {
  for (const fn of ['cmpSearchClear', 'cmpFiltersReset']) {
    assert.match(ADMIN_JS, new RegExp(`window\\.${fn} = ${fn};`), `window.${fn} export`);
  }
});

test('CAMP-AD-85: toolbar CSS — mobile-safe rules exist and are scoped to the campaigns section', () => {
  const css = read('style.css');
  for (const rule of [
    '#admin-section-campaigns .cmp-adm-toolbar {',
    '#admin-section-campaigns .cmp-adm-search {',
    '#admin-section-campaigns .cmp-adm-chips {',
    '#admin-section-campaigns .cmp-adm-count {',
    '#admin-section-campaigns .cmp-adm-reset {',
  ]) {
    assert.ok(css.includes(rule), `missing rule: ${rule}`);
  }
  // Mobile: the meta cluster and search take full rows on tiny screens.
  assert.match(css, /@media \(max-width: 480px\)[\s\S]{0,600}#admin-section-campaigns \.cmp-adm-meta/, '480px media query covers the toolbar');
  assert.match(css, /#admin-section-campaigns \.cmp-adm-search \{[\s\S]{0,200}min-width: 0/, 'search can shrink (no overflow)');
});

test('CAMP-AD-86: new adm_camp_* keys exist in fa AND en (registration link + toolbar)', () => {
  const ctx = loadI18nContext();
  for (const key of [
    'adm_camp_g_registration', 'adm_camp_field_reg_url', 'adm_camp_field_reg_url_hint',
    'adm_camp_field_reg_url_invalid', 'adm_camp_results_count', 'adm_camp_filter_reset',
    'adm_camp_search_clear', 'adm_camp_filters_label',
  ]) {
    assert.ok(key in ctx.i18n.fa, `${key} missing in fa`);
    assert.ok(key in ctx.i18n.en, `${key} missing in en`);
  }
});

test('CAMP-AD-87: user-side share/register-link i18n keys exist in fa AND en', () => {
  const ctx = loadI18nContext();
  for (const key of ['cmp_share', 'cmp_share_reg_link', 'cmp_share_copied', 'cmp_share_copy_error', 'cmp_register_url_invalid']) {
    assert.ok(key in ctx.i18n.fa, `${key} missing in fa`);
    assert.ok(key in ctx.i18n.en, `${key} missing in en`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. FORM SUBMIT — BEHAVIORAL (hotfix regression for the PR-#88 dead button)
// ═══════════════════════════════════════════════════════════════════════════
// PR #88 introduced `payload.registration_url = regUrl || null;` BEFORE the
// `var payload = _cmpBuildContentPayload(...)` declaration. With `var`
// hoisting, `payload` is undefined at the assignment → TypeError on EVERY
// submit → the async onclick handler rejected silently: no request, no
// toast, no loading state — the Save button appeared completely dead.
//
// These tests EXECUTE the real extracted `campaignFormSubmit` (and the real
// `_cmpRenderForm`) in a vm sandbox with DOM + fetch stubs, so ANY
// use-before-declaration or broken submit path fails here — a regex pin
// cannot catch ordering bugs (which is exactly how the bug shipped).

// Extract a full EXECUTABLE declaration (keeps the `async` keyword, unlike
// fnBody which is regex-pin-only).
function fnDeclSrc(name) {
  const asyncAt = ADMIN_JS.indexOf(`async function ${name}(`);
  const plainAt = ADMIN_JS.indexOf(`function ${name}(`);
  const start = (asyncAt !== -1 && (plainAt === -1 || asyncAt <= plainAt)) ? asyncAt : plainAt;
  assert.ok(start !== -1, `function not found: ${name}`);
  const rest = ADMIN_JS.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function |\n\/\/ ──|\nwindow\./);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const vm = require('node:vm');

// Minimal DOM stubs faithful to the browser semantics the code relies on:
// escapeHtml via createElement/createTextNode (innerHTML serializes text
// with & < > escaped), form inputs as {value}, toasts/fetch recorded.
function makeSubmitHarness(opts) {
  const o = opts || {};
  const calls = { fetches: [], toasts: [], marks: [], closed: 0, reloads: [] };
  const fields = o.fields || {};
  const elements = {};
  const saveBtn = { disabled: false, textContent: 'adm_camp_save' };
  for (const id of [
    'cmp-f-title', 'cmp-f-summary', 'cmp-f-body', 'cmp-f-starts', 'cmp-f-ends',
    'cmp-f-image-url', 'cmp-f-reg-url', 'cmp-f-status',
    'cmp-f-tr-title', 'cmp-f-tr-summary', 'cmp-f-tr-body',
  ]) {
    elements[id] = {
      id,
      value: fields[id] != null ? String(fields[id]) : '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      focus() { calls.focusId = id; },
      oninput: null,
    };
  }
  elements['cmp-f-save'] = saveBtn;
  const document = { getElementById: (id) => elements[id] || null };

  // Deferred fetch controller for in-flight (double-click) assertions.
  let pendingResolve = null, pendingReject = null;
  const deferred = o.deferred === true;

  const sandbox = {
    document,
    t: (k) => k,
    URL, // real URL — the client validator needs it
    _adminHasPerm: o.hasPerm != null ? o.hasPerm : () => true,
    _cmpEditingId: o.editingId || null,
    _cmpListState: { page: 3, limit: 20, status: '', search: '', total: 0, totalPages: 1 },
    // REAL pure helpers from [CMP-PURE-START]..[CMP-PURE-END]
    _cmpIsValidRegUrl: pure._cmpIsValidRegUrl,
    _cmpBuildContentPayload: pure._cmpBuildContentPayload,
    _cmpFromLocalInput: pure._cmpFromLocalInput,
    // REAL validation marker (extracted from admin.js)
    _cmpMarkInvalid: null,
    showAdminToast: (msg, kind) => { calls.toasts.push({ msg, kind }); },
    adminApiFetch: (path, options) => {
      calls.fetches.push({ path, options });
      if (deferred) {
        return new Promise((res, rej) => { pendingResolve = res; pendingReject = rej; });
      }
      if (o.fetchError) return Promise.reject(o.fetchError);
      return Promise.resolve(o.fetchResult != null ? o.fetchResult : { status: 'success', campaign: { id: 'new-1', status: 'DRAFT' } });
    },
    campaignFormClose: () => { calls.closed += 1; },
    loadAdminCampaigns: (page) => { calls.reloads.push(page); },
    console,
  };
  // The REAL _cmpMarkInvalid (records + real classList/focus behavior).
  vm.createContext(sandbox);
  vm.runInContext(fnDeclSrc('_cmpMarkInvalid'), sandbox, { filename: 'admin.js#_cmpMarkInvalid' });
  vm.runInContext(fnDeclSrc('campaignFormSubmit'), sandbox, { filename: 'admin.js#campaignFormSubmit' });
  return {
    sandbox, calls, saveBtn, elements,
    submit: () => sandbox.campaignFormSubmit(),
    settleFetch: (value) => { if (pendingResolve) pendingResolve(value); },
    failFetch: (err) => { if (pendingReject) pendingReject(err); },
  };
}

const VALID_FIELDS = {
  'cmp-f-title': 'کمپین تست هات‌فیکس',
  'cmp-f-summary': 'خلاصه تست',
  'cmp-f-body': 'متن کامل تست',
  'cmp-f-starts': '2026-10-20T12:00',
  'cmp-f-reg-url': 'https://exchange.example.com/register?via=amirbtc',
};

test('CAMP-AD-90: HOTFIX — valid form submit SENDS the request (no use-before-declaration TypeError)', async () => {
  const h = makeSubmitHarness({ fields: VALID_FIELDS });
  // The buggy PR-#88 code rejected with a TypeError and NEVER called
  // adminApiFetch — this await would throw and the assertions fail.
  await h.submit();
  assert.equal(h.calls.fetches.length, 1, 'exactly one API call');
  const { path, options } = h.calls.fetches[0];
  assert.equal(path, '/api/admin/campaigns', 'create → POST /api/admin/campaigns');
  assert.equal(options.method, 'POST');
  const payload = JSON.parse(options.body);
  assert.equal(payload.title_fa, 'کمپین تست هات‌فیکس', 'single-field title stored in its detected language');
  assert.equal(payload.registration_url, 'https://exchange.example.com/register?via=amirbtc', 'registration_url PERSISTED in the payload');
  assert.ok(Date.parse(payload.starts_at) > 0, 'starts_at is a parseable ISO timestamp');
  assert.equal(payload.status, 'DRAFT', 'create defaults to DRAFT');
  assert.deepEqual(h.calls.toasts.map((x) => x.msg), ['adm_camp_created'], 'one success toast');
  assert.equal(h.calls.closed, 1, 'form closed after success');
  assert.deepEqual(h.calls.reloads, [1], 'list reloaded from page 1');
  assert.equal(h.saveBtn.disabled, false, 'button restored (not stuck)');
});

test('CAMP-AD-91: edit mode → PUT /:id, no status field, current page preserved', async () => {
  const h = makeSubmitHarness({
    fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-reg-url': '' }),
    editingId: 'camp-42',
  });
  await h.submit();
  assert.equal(h.calls.fetches.length, 1);
  const { path, options } = h.calls.fetches[0];
  assert.equal(path, '/api/admin/campaigns/camp-42', 'edit → PUT /api/admin/campaigns/:id');
  assert.equal(options.method, 'PUT');
  const payload = JSON.parse(options.body);
  assert.equal('status' in payload, false, 'update never sends status (server rejects it)');
  assert.equal(payload.registration_url, null, 'EMPTY reg-url clears to null — never a stale link');
  assert.equal(h.calls.toasts[0].msg, 'adm_camp_updated', 'edit success toast');
  assert.deepEqual(h.calls.reloads, [3], 'edit reloads the CURRENT list page (state.page = 3)');
});

test('CAMP-AD-92: publish flow through the form — status PUBLISHED is sent on create', async () => {
  const h = makeSubmitHarness({ fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-status': 'PUBLISHED' }) });
  await h.submit();
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(JSON.parse(h.calls.fetches[0].options.body).status, 'PUBLISHED', '«انتشار» via the form = PUBLISHED in the create payload');
});

test('CAMP-AD-93: validation gates stop BEFORE any request (title/starts/reg-url/ends)', async () => {
  // Missing title.
  let h = makeSubmitHarness({ fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-title': '   ' }) });
  await h.submit();
  assert.equal(h.calls.fetches.length, 0, 'no request on missing title');
  assert.equal(h.calls.toasts[0].msg, 'adm_camp_field_title');
  assert.ok(h.elements['cmp-f-title'].classList.contains('cmp-adm-invalid'), 'title visibly marked');

  // Missing starts_at.
  h = makeSubmitHarness({ fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-starts': '' }) });
  await h.submit();
  assert.equal(h.calls.fetches.length, 0, 'no request on missing starts');
  assert.equal(h.calls.toasts[0].msg, 'adm_camp_field_starts');

  // Dangerous registration URL scheme.
  h = makeSubmitHarness({ fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-reg-url': 'javascript:alert(document.domain)' }) });
  await h.submit();
  assert.equal(h.calls.fetches.length, 0, 'no request on javascript: URL');
  assert.equal(h.calls.toasts[0].msg, 'adm_camp_field_reg_url_invalid');
  assert.ok(h.elements['cmp-f-reg-url'].classList.contains('cmp-adm-invalid'), 'reg-url visibly marked');

  // ends_at before starts_at.
  h = makeSubmitHarness({ fields: Object.assign({}, VALID_FIELDS, { 'cmp-f-ends': '2020-01-01T00:00' }) });
  await h.submit();
  assert.equal(h.calls.fetches.length, 0, 'no request on reversed window');
  assert.equal(h.calls.toasts[0].msg, 'adm_camp_field_ends');
});

test('CAMP-AD-94: API failure → honest error toast with the REAL message; button re-enabled for retry', async () => {
  const err = new Error('HTTP 422');
  err.status = 422;
  err.body = { errors: [{ field: 'starts_at', message: 'must be a future ISO-8601 timestamp' }] };
  const h = makeSubmitHarness({ fields: VALID_FIELDS, fetchError: err });
  await h.submit(); // must NOT throw out of the handler
  assert.equal(h.calls.fetches.length, 1, 'the request WAS sent');
  assert.equal(h.calls.toasts.length, 1, 'exactly one error toast');
  assert.equal(h.calls.toasts[0].kind, 'error');
  assert.equal(h.calls.toasts[0].msg, 'starts_at: must be a future ISO-8601 timestamp', 'server field errors surfaced verbatim');
  assert.equal(h.calls.closed, 0, 'form stays open on failure');
  assert.equal(h.saveBtn.disabled, false, 'button NOT permanently disabled');
  assert.equal(h.saveBtn.textContent, 'adm_camp_save', 'label restored');

  // Plain network error → the raw message is surfaced (not swallowed).
  const h2 = makeSubmitHarness({ fields: VALID_FIELDS, fetchError: new Error('network down') });
  await h2.submit();
  assert.equal(h2.calls.toasts[0].msg, 'network down');
  assert.equal(h2.saveBtn.disabled, false, 'retry possible after network failure');
});

test('CAMP-AD-95: in-flight lock + rapid re-click — ONE request per submit, retry after settle', async () => {
  const h = makeSubmitHarness({ fields: VALID_FIELDS, deferred: true });
  const p1 = h.submit();
  assert.equal(h.saveBtn.disabled, true, 'button locked while in-flight (a real second click cannot fire)');
  assert.equal(h.saveBtn.textContent, 'adm_camp_saving', 'loading feedback shown');
  h.settleFetch({ status: 'success', campaign: { id: 'new-1', status: 'DRAFT' } });
  await p1;
  assert.equal(h.calls.fetches.length, 1, 'exactly ONE request for the click');
  assert.equal(h.saveBtn.disabled, false, 'unlocked after completion');

  // The user may submit again afterwards (retry / next edit) — never a
  // permanent disable.
  const p2 = h.submit();
  h.settleFetch({ status: 'success', campaign: { id: 'new-2', status: 'DRAFT' } });
  await p2;
  assert.equal(h.calls.fetches.length, 2, 'a subsequent submit works (no permanent disable)');
});

test('CAMP-AD-96: campaigns.manage permission is checked before ANY work', async () => {
  const h = makeSubmitHarness({ fields: VALID_FIELDS, hasPerm: () => false });
  await h.submit();
  assert.equal(h.calls.fetches.length, 0, 'no request without campaigns.manage');
  assert.equal(h.calls.toasts[0].msg, 'adm_no_access');
});

test('CAMP-AD-97: edit form prefills the STORED registration_url (reopen persistence)', () => {
  // Execute the REAL _cmpRenderForm with a stored campaign and verify the
  // input carries the stored value (the reopen path re-fetches the row and
  // renders from it — this locks that contract behaviorally).
  const escapeDoc = {
    createElement: () => {
      const el = { _children: [] };
      Object.defineProperty(el, 'innerHTML', {
        get() {
          return el._children.map((c) => String(c.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('');
        },
      });
      el.appendChild = (n) => { el._children.push(n); };
      return el;
    },
    createTextNode: (s) => ({ text: String(s) }),
  };
  const sandbox = {
    t: (k) => k,
    _cmpPanelLang: pure._cmpPanelLang,
    _cmpToLocalInput: pure._cmpToLocalInput,
    _cmpAdminImgUrl: pure._cmpAdminImgUrl,
    CMP_ICONS: { basic: '', schedule: '', image: '', publish: '', link: '' },
    document: Object.assign({ getElementById: () => null }, escapeDoc),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fnDeclSrc('adminEscapeHtml'), ctx, { filename: 'admin.js#adminEscapeHtml' });
  vm.runInContext(fnDeclSrc('_cmpRenderForm'), ctx, { filename: 'admin.js#_cmpRenderForm' });
  const box = { innerHTML: '' };
  ctx._cmpRenderForm(box, {
    id: 'camp-9',
    title_fa: 'کمپین ذخیره‌شده', title_en: 'Stored campaign',
    summary_fa: null, summary_en: null, body_fa: '', body_en: '',
    image_url: null,
    registration_url: 'https://exchange.example.com/register?via=amirbtc',
    starts_at: '2026-10-20T09:00:00.000Z', ends_at: null,
    status: 'PUBLISHED',
  });
  const m = box.innerHTML.match(/<input type="text" id="cmp-f-reg-url"[^>]*value="([^"]*)"/);
  assert.ok(m, 'registration URL input rendered');
  assert.equal(m[1], 'https://exchange.example.com/register?via=amirbtc', 'stored URL prefilled — survives form reopen');
});

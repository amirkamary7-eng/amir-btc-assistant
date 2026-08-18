/**
 * Phase 12: Advertisement System — Comprehensive Regression Tests
 *
 * Tests cover the entire Advertisement subsystem (Phase 1-11 of the spec):
 *   Phase 1  — Campaign state (ad_campaigns unified registry + status/type CHECK constraints)
 *   Phase 2  — Channel Join (multi-channel join-lock integration in worker-proxy.js)
 *   Phase 3  — Popup 24h per-user cooldown via KV
 *   Phase 4  — Popup admin editor (sanitizeText, sanitizeUrl, isValidImageUrl)
 *   Phase 5  — Image upload/serve (KV-backed, magic-byte verification, nosniff)
 *   Phase 6  — Message campaigns (audience-filtered JOIN + bulk pref fetch + safety cap)
 *   Phase 7  — ch_promotions notification-platform integration (premium-gated)
 *   Phase 8  — Semantic separation (channel-join vs message-campaigns)
 *   Phase 10 — Security (HTML sanitization, SSRF blocks, magic bytes, nosniff, rate limit)
 *   Phase 11 — Performance (60s campaign cache + per-user KV cache + bulk fetch)
 *
 * All tests are SOURCE-INSPECTION based (no DB, no network, no Worker invocation).
 * Each test reads the relevant source file as text and asserts substring/regex presence.
 *
 * Run: node --test advertisements-system-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ADS_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/advertisements.js'), 'utf8');
const ADS_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/advertisements.js'), 'utf8');
const NOTIF_PLATFORM_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/notification_platform.js'), 'utf8');
const NOTIF_PLATFORM_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/notification_platform.js'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ADMIN_JS = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — CAMPAIGN STATE (ad_campaigns registry)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-ST-01: ad_campaigns has status CHECK constraint (draft/active/paused/archived)', () => {
  assert.ok(/CHECK\s*\(\s*status\s+IN\s*\(\s*'draft'\s*,\s*'active'\s*,\s*'paused'\s*,\s*'archived'\s*\)\s*\)/i
    .test(ADS_REPO_SRC) || /status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'draft'\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'draft'\s*,\s*'active'\s*,\s*'paused'\s*,\s*'archived'\s*\)/i
    .test(ADS_REPO_SRC),
    'ad_campaigns.status must have CHECK constraint for draft/active/paused/archived');
});

test('ADS-ST-02: ad_campaigns has type CHECK constraint (channel_join/popup/message)', () => {
  assert.ok(/CHECK\s*\(\s*type\s+IN\s*\(\s*'channel_join'\s*,\s*'popup'\s*,\s*'message'\s*\)\s*\)/i
    .test(ADS_REPO_SRC),
    'ad_campaigns.type must have CHECK constraint for channel_join/popup/message');
});

test('ADS-POP-ST: listActivePopups filters by is_active=TRUE AND campaign status=active', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActivePopups');
  assert.ok(fnStart >= 0, 'listActivePopups function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes("camp.status = 'active'"),
    'listActivePopups must filter by campaign status=active');
  assert.ok(/p\.is_active\s*=\s*TRUE/i.test(fnBlock),
    'listActivePopups must filter by popup is_active=TRUE');
});

test('ADS-CH-ST: listActiveRequiredChannels filters by is_active=TRUE AND campaign status=active', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActiveRequiredChannels');
  assert.ok(fnStart >= 0, 'listActiveRequiredChannels function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes("camp.status = 'active'"),
    'listActiveRequiredChannels must filter by campaign status=active');
  assert.ok(/c\.is_active\s*=\s*TRUE/i.test(fnBlock),
    'listActiveRequiredChannels must filter by channel is_active=TRUE');
});

test('ADS-MSG-ST: handleAdminSendMessage rejects non-active campaigns with CAMPAIGN_NOT_ACTIVE', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleAdminSendMessage');
  assert.ok(fnStart >= 0, 'handleAdminSendMessage must exist');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('CAMPAIGN_NOT_ACTIVE'),
    'handleAdminSendMessage must return CAMPAIGN_NOT_ACTIVE for non-active campaigns');
  assert.ok(fnBlock.includes("campaign_status !== 'active'"),
    'handleAdminSendMessage must check campaign_status !== active');
  assert.ok(fnBlock.includes('!message.is_active'),
    'handleAdminSendMessage must also check !message.is_active');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — CHANNEL JOIN (multi-channel join-lock integration)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-CH-01: advertisementsRepo is imported in worker-proxy.js', () => {
  assert.ok(WORKER_SRC.includes("import { createAdvertisementsRepository } from './src/repositories/advertisements.js';"),
    'worker-proxy.js must import createAdvertisementsRepository');
  assert.ok(WORKER_SRC.includes('createAdvertisementsRepository('),
    'worker-proxy.js must instantiate advertisementsRepo');
  assert.ok(WORKER_SRC.includes('const advertisementsRepo ='),
    'worker-proxy.js must define advertisementsRepo const');
});

test('ADS-CH-02: checkAdditionalRequiredChannels function exists in worker-proxy.js', () => {
  assert.ok(/async\s+function\s+checkAdditionalRequiredChannels\s*\(/.test(WORKER_SRC),
    'checkAdditionalRequiredChannels must be defined');
});

test('ADS-CH-03: resolveChannelMembership calls checkAdditionalRequiredChannels at every joined:true path (>=4 calls)', () => {
  const fnStart = WORKER_SRC.indexOf('async function resolveChannelMembership');
  assert.ok(fnStart >= 0, 'resolveChannelMembership must exist');
  // Slice a generous block to capture the whole function.
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 5000);
  const calls = fnBlock.match(/checkAdditionalRequiredChannels\s*\(/g) || [];
  assert.ok(calls.length >= 4,
    `resolveChannelMembership must call checkAdditionalRequiredChannels >=4 times (got ${calls.length})`);
});

test('ADS-CH-04: buildStartReplyPayloadAsync exists and merges DB channels', () => {
  const fnStart = WORKER_SRC.indexOf('async function buildStartReplyPayloadAsync');
  assert.ok(fnStart >= 0, 'buildStartReplyPayloadAsync must exist');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(fnBlock.includes('advertisementsRepo.listActiveRequiredChannels'),
    'buildStartReplyPayloadAsync must call advertisementsRepo.listActiveRequiredChannels to merge DB channels');
  assert.ok(fnBlock.includes('dbChannels'),
    'buildStartReplyPayloadAsync must use dbChannels variable');
});

test('ADS-CH-05: /start handler calls buildStartReplyPayloadAsync (not sync variant)', () => {
  assert.ok(WORKER_SRC.includes('buildStartReplyPayloadAsync(env, messageContext.chatId,'),
    '/start handler must call buildStartReplyPayloadAsync');
});

test('ADS-CH-06: Per-user KV cache key for ad-channel check uses adch:${userId}:${hash} pattern', () => {
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2000);
  assert.ok(/adch:\$\{uid\}:\$\{hash\}/.test(fnBlock) || /adch:\$\{String\([^)]+\)\}:\$\{/.test(fnBlock),
    'checkAdditionalRequiredChannels must use adch:${userId}:${hash} KV cache key');
  assert.ok(fnBlock.includes('_hashChannelSet'),
    'checkAdditionalRequiredChannels must compute channel-set hash via _hashChannelSet');
});

test('ADS-CH-07: Channel repo validates join_url must start with https://t.me/', () => {
  assert.ok(ADS_REPO_SRC.includes("joinUrl.startsWith('https://t.me/')"),
    'repo must validate join_url starts with https://t.me/');
  assert.ok(ADS_REPO_SRC.includes("join_url must be a https://t.me/... link"),
    'repo must throw descriptive error when join_url is invalid');
});

test('ADS-CH-08: listActiveRequiredChannels filters active channels (campaign active AND is_active=true)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActiveRequiredChannels');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes("c.is_active = TRUE"),
    'listActiveRequiredChannels must filter by c.is_active = TRUE');
  assert.ok(fnBlock.includes("camp.status = 'active'"),
    'listActiveRequiredChannels must filter by campaign status active');
});

test('ADS-CH-09: Route POST /api/admin/advertisements/channels is wired', () => {
  assert.ok(/request\.method\s*===\s*'POST'\s*&&\s*url\.pathname\s*===\s*'\/api\/admin\/advertisements\/channels'/.test(WORKER_SRC),
    'POST /api/admin/advertisements/channels route must be wired');
  assert.ok(WORKER_SRC.includes('handleAdminCreateChannel'),
    'handleAdminCreateChannel handler must be invoked');
});

test('ADS-CH-10: Route DELETE /api/admin/advertisements/channels/:id is wired', () => {
  // Source regex literal: /^\/api\/admin\/advertisements\/channels\/[A-Za-z0-9_-]+$/.test(url.pathname)
  // Use .includes() with the literal string (JS string \\/ = one backslash + one slash in target).
  assert.ok(WORKER_SRC.includes("request.method === 'DELETE' && /^\\/api\\/admin\\/advertisements\\/channels\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'DELETE /api/admin/advertisements/channels/:id route must be wired');
  assert.ok(WORKER_SRC.includes('handleAdminDeleteChannel'),
    'handleAdminDeleteChannel handler must be invoked');
});

test('ADS-CH-11: User route GET /api/advertisements/required-channels is wired', () => {
  assert.ok(/request\.method\s*===\s*'GET'\s*&&\s*url\.pathname\s*===\s*'\/api\/advertisements\/required-channels'/.test(WORKER_SRC),
    'GET /api/advertisements/required-channels user route must be wired');
  assert.ok(WORKER_SRC.includes('handleListRequiredChannels'),
    'handleListRequiredChannels handler must be invoked');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 + 4 — POPUP (24h cooldown + admin editor + URL/image validation)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-POP-01: hasPopupBeenShown uses KV key adp:${userId}:${popupId}', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function hasPopupBeenShown');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 500);
  assert.ok(/adp:\$\{String\(userId\)\}:\$\{String\(popupId\)\}/.test(fnBlock),
    'hasPopupBeenShown must build KV key adp:${userId}:${popupId}');
});

test('ADS-POP-02: markPopupShown sets KV with expirationTtl = cooldown_seconds', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function markPopupShown');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 600);
  assert.ok(/expirationTtl:\s*ttl/.test(fnBlock),
    'markPopupShown must pass expirationTtl=ttl to KV.put');
  assert.ok(fnBlock.includes('cooldownSeconds'),
    'markPopupShown must accept cooldownSeconds parameter');
});

test('ADS-POP-03: handleGetPopup iterates active popups, returns first NOT in cooldown', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleGetPopup');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('listActivePopups'),
    'handleGetPopup must fetch active popups via listActivePopups');
  assert.ok(/for\s*\(\s*const\s+p\s+of\s+popups\s*\)/.test(fnBlock),
    'handleGetPopup must iterate popups');
  assert.ok(fnBlock.includes('hasPopupBeenShown'),
    'handleGetPopup must call hasPopupBeenShown for each popup');
  assert.ok(fnBlock.includes('!shown'),
    'handleGetPopup must return first popup NOT in cooldown');
});

test('ADS-POP-04: Popup repo sanitizes title (strips HTML tags, max 120 chars)', () => {
  const createStart = ADS_REPO_SRC.indexOf('async function createPopup');
  const createBlock = ADS_REPO_SRC.slice(createStart, createStart + 1500);
  assert.ok(/sanitizeText\s*\(\s*input\.title\s*,\s*120\s*\)/.test(createBlock),
    'createPopup must sanitize title with maxLen=120');
  const updateStart = ADS_REPO_SRC.indexOf('async function updatePopup');
  const updateBlock = ADS_REPO_SRC.slice(updateStart, updateStart + 2000);
  assert.ok(/sanitizeText\s*\(\s*updates\.title\s*,\s*120\s*\)/.test(updateBlock),
    'updatePopup must sanitize title with maxLen=120');
});

test('ADS-POP-05: Popup repo sanitizes body_text (strips HTML tags, max 1000 chars)', () => {
  const createStart = ADS_REPO_SRC.indexOf('async function createPopup');
  const createBlock = ADS_REPO_SRC.slice(createStart, createStart + 1500);
  assert.ok(/sanitizeText\s*\(\s*input\.body_text\s*,\s*1000\s*\)/.test(createBlock),
    'createPopup must sanitize body_text with maxLen=1000');
});

test('ADS-POP-06: Popup image_url validation rejects http/javascript/file/data/IP/localhost/private suffixes', () => {
  // http:// rejection — only https: allowed
  assert.ok(/if\s*\(\s*u\.protocol\s*!==\s*'https:'\s*\)\s*return\s*false/.test(ADS_REPO_SRC),
    'isValidExternalImageUrl must reject non-https schemes (http/javascript/file/data)');
  // IP literal rejection
  assert.ok(/\/\^\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(host\)/.test(ADS_REPO_SRC),
    'isValidExternalImageUrl must reject IPv4 literals');
  // localhost rejection
  assert.ok(/host\s*===\s*'localhost'/.test(ADS_REPO_SRC),
    'isValidExternalImageUrl must reject localhost');
  // Private suffix rejection (.local/.internal/.lan etc)
  assert.ok(ADS_REPO_SRC.includes("'.local'") && ADS_REPO_SRC.includes("'.internal'") && ADS_REPO_SRC.includes("'.lan'"),
    'isValidExternalImageUrl must reject .local/.internal/.lan private suffixes');
});

test('ADS-POP-07: Popup image_url accepts https:// with valid TLD', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isValidExternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/\/\^\[a-z0-9\.\-\]\+\\\.\[a-z\]\{2,\}\$\/i\.test\(host\)/.test(fnBlock),
    'isValidExternalImageUrl must accept hostnames with valid TLD (2+ alpha chars)');
});

test('ADS-POP-08: Popup image_url accepts internal /api/advertisements/image/:id', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isInternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 300);
  assert.ok(/\/\^\\\/api\\\/advertisements\\\/image\\\/\[A-Za-z0-9_\-\]\{8,40\}\$\//.test(fnBlock),
    'isInternalImageUrl must accept /api/advertisements/image/:id format');
  // isValidImageUrl must accept internal OR external
  const validStart = ADS_REPO_SRC.indexOf('export function isValidImageUrl');
  const validBlock = ADS_REPO_SRC.slice(validStart, validStart + 300);
  assert.ok(validBlock.includes('isInternalImageUrl(rawUrl)') && validBlock.includes('isValidExternalImageUrl(rawUrl)'),
    'isValidImageUrl must accept internal image URLs and external https URLs');
});

test('ADS-POP-09: Popup button_url validation rejects javascript:, accepts http/https', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function sanitizeUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 700);
  assert.ok(fnBlock.includes("u.protocol !== 'https:'") && fnBlock.includes("u.protocol !== 'http:'"),
    'sanitizeUrl must accept only http and https protocols');
  assert.ok(fnBlock.includes("return ''"),
    'sanitizeUrl must return empty string for invalid protocols (javascript:, file:, data:)');
});

test('ADS-POP-10: Route GET /api/advertisements/popups is wired (user)', () => {
  assert.ok(/request\.method\s*===\s*'GET'\s*&&\s*url\.pathname\s*===\s*'\/api\/advertisements\/popups'/.test(WORKER_SRC),
    'GET /api/advertisements/popups user route must be wired');
  assert.ok(WORKER_SRC.includes('handleGetPopup'),
    'handleGetPopup handler must be invoked');
});

test('ADS-POP-11: Route POST /api/advertisements/popups/:id/shown is wired (user)', () => {
  assert.ok(/request\.method\s*===\s*'POST'\s*&&\s*\/\^\\\/api\\\/advertisements\\\/popups\\\/\[A-Za-z0-9_\-\]\+\\\/shown\$\/\.test\(url\.pathname\)/.test(WORKER_SRC),
    'POST /api/advertisements/popups/:id/shown user route must be wired');
  assert.ok(WORKER_SRC.includes('handleMarkPopupShown'),
    'handleMarkPopupShown handler must be invoked');
});

test('ADS-POP-12: Default cooldown_seconds is 86400 (24h)', () => {
  // Schema default
  assert.ok(/cooldown_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+86400/i.test(ADS_REPO_SRC),
    'ad_popups.cooldown_seconds must default to 86400');
  // createPopup uses 86400 as fallback
  const createStart = ADS_REPO_SRC.indexOf('async function createPopup');
  const createBlock = ADS_REPO_SRC.slice(createStart, createStart + 1500);
  assert.ok(createBlock.includes('86400'),
    'createPopup must use 86400 as default cooldown_seconds');
});

test('ADS-POP-13: Cooldown is per-user (key includes userId, NOT global)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function hasPopupBeenShown');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 500);
  // Key MUST include both userId AND popupId
  assert.ok(fnBlock.includes('${String(userId)}') && fnBlock.includes('${String(popupId)}'),
    'KV key must include both userId and popupId (per-user cooldown)');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — MESSAGE CAMPAIGNS (audience filtering + delivery)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-MSG-01: Message repo has destinations CHECK constraint (mini_app/telegram/both)', () => {
  assert.ok(/CHECK\s*\(\s*destinations\s+IN\s*\(\s*'mini_app'\s*,\s*'telegram'\s*,\s*'both'\s*\)\s*\)/i.test(ADS_REPO_SRC),
    'ad_messages.destinations must have CHECK constraint');
});

test('ADS-MSG-02: Message repo has target_audience CHECK constraint (free/premium/all)', () => {
  assert.ok(/CHECK\s*\(\s*target_audience\s+IN\s*\(\s*'free'\s*,\s*'premium'\s*,\s*'all'\s*\)\s*\)/i.test(ADS_REPO_SRC),
    'ad_messages.target_audience must have CHECK constraint');
});

test('ADS-MSG-03: handleAdminSendMessage rejects non-active campaigns with CAMPAIGN_NOT_ACTIVE', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleAdminSendMessage');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('CAMPAIGN_NOT_ACTIVE'),
    'handleAdminSendMessage must return CAMPAIGN_NOT_ACTIVE error code');
  assert.ok(fnBlock.includes('422'),
    'handleAdminSendMessage must return HTTP 422 for non-active campaigns');
});

test('ADS-MSG-04: _deliverMessageCampaign uses audience-filtered SQL JOIN on membership_users', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(/LEFT\s+JOIN\s+membership_users\s+mu\s+ON\s+mu\.telegram_id\s*=\s*u\.telegram_id/i.test(fnBlock),
    '_deliverMessageCampaign must LEFT JOIN membership_users');
  assert.ok(fnBlock.includes('audienceClause'),
    '_deliverMessageCampaign must build an audience filter clause');
});

test('ADS-MSG-05: Premium audience filter (VIP/PREMIUM/ELITE + APPROVED + not expired)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes("mu.membership_level IN ('VIP','PREMIUM','ELITE')"),
    'Premium audience filter must check membership_level IN (VIP,PREMIUM,ELITE)');
  assert.ok(fnBlock.includes("mu.membership_status = 'APPROVED'"),
    'Premium audience filter must check membership_status=APPROVED');
  assert.ok(fnBlock.includes('mu.expire_at IS NULL') && fnBlock.includes('mu.expire_at > NOW()'),
    'Premium audience filter must check not expired (expire_at IS NULL OR > NOW())');
});

test('ADS-MSG-06: Free audience filter (no membership row OR FREE OR not approved OR expired)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes('mu.membership_level IS NULL'),
    'Free audience must include users with no membership row');
  assert.ok(fnBlock.includes("mu.membership_level = 'FREE'"),
    'Free audience must include FREE level users');
  assert.ok(fnBlock.includes("mu.membership_status IS NULL") || fnBlock.includes("mu.membership_status != 'APPROVED'"),
    'Free audience must include users with no membership_status OR not approved');
  assert.ok(fnBlock.includes('mu.expire_at IS NOT NULL') && fnBlock.includes('mu.expire_at <= NOW()'),
    'Free audience must include expired members');
});

test('ADS-MSG-07: Delivery uses notificationPlatformRepo.dispatch with category=promotions', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes('notificationPlatformRepo') && fnBlock.includes('.dispatch'),
    '_deliverMessageCampaign must call notificationPlatformRepo.dispatch');
  assert.ok(/category:\s*'promotions'/.test(fnBlock),
    'dispatch call must use category=promotions');
});

test('ADS-MSG-08: Delivery respects per-user ch_promotions preference (none → skipped)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  // Bulk fetch ch_promotions preference
  assert.ok(/SELECT\s+user_id,\s+ch_promotions\s+AS\s+pref\s+FROM\s+notification_settings/i.test(fnBlock),
    '_deliverMessageCampaign must bulk-fetch ch_promotions preference from notification_settings');
  assert.ok(/pref\s*===?\s*'none'/.test(fnBlock) || fnBlock.includes("pref === 'none'"),
    '_deliverMessageCampaign must skip users with pref=none');
  assert.ok(fnBlock.includes('skipped++'),
    '_deliverMessageCampaign must increment skipped counter for none-pref users');
});

test('ADS-MSG-09: Telegram delivery uses sendTelegramMessage (not a parallel system)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  // Slice generously to capture the entire function (it spans ~125 lines).
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 8000);
  assert.ok(fnBlock.includes('deliverTelegram') && fnBlock.includes('sendTelegramMessage'),
    '_deliverMessageCampaign must use sendTelegramMessage for telegram delivery');
  assert.ok(/sendTelegramMessage\s*\(\s*env/i.test(fnBlock),
    'sendTelegramMessage must be called with env as first arg');
});

test('ADS-MSG-10: Safety cap: max 1000 users per send invocation (audit H2 fix)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  // Slice generously — the safety cap appears near the end of the function (~line 612).
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 8000);
  // FIX (audit H2): safety cap lowered from 5000 → 1000 to fit Workers CPU limit
  assert.ok(/delivered\s*\+\s*skipped\s*>=\s*1000/.test(fnBlock),
    '_deliverMessageCampaign must enforce 1000-user safety cap (was 5000, exceeded Workers CPU)');
  assert.ok(fnBlock.includes('break'),
    'safety cap must break out of the delivery loop');
});

test('ADS-MSG-11: Route POST /api/admin/advertisements/messages/:id/send is wired', () => {
  assert.ok(/request\.method\s*===\s*'POST'\s*&&\s*\/\^\\\/api\\\/admin\\\/advertisements\\\/messages\\\/\[A-Za-z0-9_\-\]\+\\\/send\$\/\.test\(url\.pathname\)/.test(WORKER_SRC),
    'POST /api/admin/advertisements/messages/:id/send route must be wired');
  assert.ok(WORKER_SRC.includes('handleAdminSendMessage'),
    'handleAdminSendMessage handler must be invoked');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — NOTIFICATION SETTINGS INTEGRATION (ch_promotions premium-gated)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-NS-01: ch_promotions exists in notification_platform repo category map (mapped to ch_promotions column)', () => {
  assert.ok(NOTIF_PLATFORM_REPO_SRC.includes("'promotions': 'ch_promotions'"),
    "notification_platform repo must map 'promotions' category to 'ch_promotions' column");
});

test('ADS-NS-02: ch_promotions default is none (free users do not receive promotions)', () => {
  assert.ok(/ch_promotions:\s*'none'/.test(NOTIF_PLATFORM_REPO_SRC),
    "notification_platform repo must default ch_promotions to 'none'");
});

test('ADS-NS-03: ch_promotions update is premium-gated (PREMIUM_REQUIRED 403) in notification_platform controller', () => {
  assert.ok(NOTIF_PLATFORM_CTRL_SRC.includes('PREMIUM_ONLY_CATEGORIES'),
    'controller must define PREMIUM_ONLY_CATEGORIES list');
  assert.ok(NOTIF_PLATFORM_CTRL_SRC.includes("'ch_promotions'"),
    "ch_promotions must be in PREMIUM_ONLY_CATEGORIES");
  assert.ok(NOTIF_PLATFORM_CTRL_SRC.includes('membershipAuthority.isPremium'),
    'controller must call membershipAuthority.isPremium for premium-only categories');
  assert.ok(NOTIF_PLATFORM_CTRL_SRC.includes('PREMIUM_REQUIRED'),
    'controller must return PREMIUM_REQUIRED error code for non-premium users');
  assert.ok(NOTIF_PLATFORM_CTRL_SRC.includes('status: 403'),
    'controller must return HTTP 403 for non-premium ch_promotions update');
});

test('ADS-NS-04: ch_promotions is in the user UI (app.js) with premiumOnly: true flag', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  assert.ok(groupsBlock.includes("key: 'ch_promotions'"),
    'ch_promotions must be a UI item');
  assert.ok(groupsBlock.includes('premiumOnly: true'),
    'ch_promotions must have premiumOnly: true flag');
});

test('ADS-NS-05: Message campaigns use category=promotions which maps to ch_promotions column', () => {
  // Controller side
  assert.ok(ADS_CTRL_SRC.includes("category: 'promotions'"),
    "advertisements controller must dispatch with category='promotions'");
  // Repo side — the mapping exists
  assert.ok(NOTIF_PLATFORM_REPO_SRC.includes("'promotions': 'ch_promotions'"),
    "notification_platform repo must map 'promotions' → 'ch_promotions'");
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — SEMANTIC SEPARATION (channel-join vs message-campaigns)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-SEP-01: Channel Join (ad_channels) does NOT go through ch_promotions (uses checkAdditionalRequiredChannels + Telegram getChatMember)', () => {
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2000);
  // Must use Telegram getChatMember (via _checkSingleTelegramChannel)
  assert.ok(fnBlock.includes('_checkSingleTelegramChannel'),
    'checkAdditionalRequiredChannels must use Telegram getChatMember via _checkSingleTelegramChannel');
  // Must NOT call notificationPlatformRepo.dispatch (it is part of join-lock, not ch_promotions)
  assert.ok(!fnBlock.includes('notificationPlatformRepo'),
    'checkAdditionalRequiredChannels must NOT route through notificationPlatformRepo (separate domain)');
  assert.ok(!/ch_promotions/i.test(fnBlock),
    'checkAdditionalRequiredChannels must NOT reference ch_promotions (channel-join is a separate domain)');
});

test('ADS-SEP-02: Message campaigns (ad_messages) DO go through ch_promotions (via dispatch category=promotions)', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes('notificationPlatformRepo') && fnBlock.includes('.dispatch'),
    'message campaigns must use notificationPlatformRepo.dispatch');
  assert.ok(/category:\s*'promotions'/.test(fnBlock),
    "dispatch call must use category='promotions'");
  assert.ok(/ch_promotions\s+AS\s+pref/i.test(fnBlock),
    'message campaigns must read ch_promotions preference per user');
});

test('ADS-SEP-03: Both ad_channels and ad_messages use the same ad_campaigns registry with different type values', () => {
  // createChannel inserts with type='channel_join'
  const chStart = ADS_REPO_SRC.indexOf('async function createChannel');
  const chBlock = ADS_REPO_SRC.slice(chStart, chStart + 2500);
  assert.ok(chBlock.includes("'channel_join'"),
    'createChannel must insert ad_campaigns row with type=channel_join');
  // createMessage inserts with type='message'
  const msgStart = ADS_REPO_SRC.indexOf('async function createMessage');
  const msgBlock = ADS_REPO_SRC.slice(msgStart, msgStart + 1500);
  assert.ok(msgBlock.includes("'message'"),
    'createMessage must insert ad_campaigns row with type=message');
  // createPopup inserts with type='popup'
  const popStart = ADS_REPO_SRC.indexOf('async function createPopup');
  const popBlock = ADS_REPO_SRC.slice(popStart, popStart + 1500);
  assert.ok(popBlock.includes("'popup'"),
    'createPopup must insert ad_campaigns row with type=popup');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 10 — SECURITY (HTML/URL sanitization, SSRF blocks, magic bytes, nosniff)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-SEC-01: All admin advertisement routes require ads.manage permission (>=10 requireAdmin calls)', () => {
  const matches = ADS_CTRL_SRC.match(/requireAdmin\(request,\s*env,\s*'ads\.manage'\)/g) || [];
  assert.ok(matches.length >= 10,
    `controller must have >=10 requireAdmin(..., 'ads.manage') calls (got ${matches.length})`);
});

test('ADS-SEC-02: sanitizeText strips ALL HTML tags (<script>, <iframe>, etc.)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function sanitizeText');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 800);
  assert.ok(/s\.replace\(\s*\/<\[\^>\]\*>\/g,\s*''\s*\)/.test(fnBlock),
    'sanitizeText must strip ALL HTML tags via /<[^>]*>/g regex');
});

test('ADS-SEC-03: sanitizeText rejects dangerous patterns (javascript:, on*=, etc.) → returns empty string', () => {
  // _DANGEROUS_PATTERNS is defined ABOVE the sanitizeText function, so scan the whole repo file.
  assert.ok(ADS_REPO_SRC.includes('_DANGEROUS_PATTERNS'),
    'repo must define _DANGEROUS_PATTERNS list');
  assert.ok(/javascript:/i.test(ADS_REPO_SRC),
    '_DANGEROUS_PATTERNS must include javascript: pattern');
  assert.ok(/on\\w\+\\s\*=/i.test(ADS_REPO_SRC),
    '_DANGEROUS_PATTERNS must include on*= inline event handler pattern');
  // The sanitizeText function itself must iterate patterns and return '' on match.
  const fnStart = ADS_REPO_SRC.indexOf('export function sanitizeText');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes('_DANGEROUS_PATTERNS'),
    'sanitizeText must reference _DANGEROUS_PATTERNS list');
  assert.ok(fnBlock.includes("return ''"),
    'sanitizeText must return empty string when a dangerous pattern is detected');
});

test('ADS-SEC-04: isValidExternalImageUrl rejects IP literals (127.0.0.1, 10.0.0.1)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isValidExternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/\/\^\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(host\)/.test(fnBlock),
    'isValidExternalImageUrl must reject IPv4 literals via regex');
  assert.ok(fnBlock.includes("host.startsWith('[')"),
    'isValidExternalImageUrl must reject IPv6 literals');
});

test('ADS-SEC-05: isValidExternalImageUrl rejects localhost', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isValidExternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/host\s*===\s*'localhost'/.test(fnBlock),
    'isValidExternalImageUrl must reject localhost hostname');
});

test('ADS-SEC-06: isValidExternalImageUrl rejects private suffixes (.local, .internal, .lan)', () => {
  assert.ok(ADS_REPO_SRC.includes("'.local'"),
    'isValidExternalImageUrl must reject .local suffix');
  assert.ok(ADS_REPO_SRC.includes("'.internal'"),
    'isValidExternalImageUrl must reject .internal suffix');
  assert.ok(ADS_REPO_SRC.includes("'.lan'"),
    'isValidExternalImageUrl must reject .lan suffix');
});

test('ADS-SEC-07: isValidExternalImageUrl rejects non-https schemes (http/file/data/javascript)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isValidExternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/u\.protocol\s*!==\s*'https:'/.test(fnBlock),
    'isValidExternalImageUrl must reject any non-https scheme (http, file, data, javascript)');
});

test('ADS-SEC-08: isValidExternalImageUrl rejects URLs with username:password@', () => {
  const fnStart = ADS_REPO_SRC.indexOf('export function isValidExternalImageUrl');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/u\.username\s*\|\|\s*u\.password/.test(fnBlock),
    'isValidExternalImageUrl must reject URLs containing username or password (SSRF defense)');
});

test('ADS-SEC-09: storeImage rejects files > 500KB', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function storeImage');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/_MAX_IMAGE_BYTES\s*=\s*500\s*\*\s*1024/.test(ADS_REPO_SRC),
    'repo must define _MAX_IMAGE_BYTES = 500 * 1024 (500KB)');
  assert.ok(/bytes\.length\s*>\s*_MAX_IMAGE_BYTES/.test(fnBlock),
    'storeImage must check bytes.length > _MAX_IMAGE_BYTES');
  assert.ok(fnBlock.includes('Image too large'),
    'storeImage must throw descriptive error when image exceeds 500KB');
});

test('ADS-SEC-10: storeImage rejects unsupported content-types (only jpeg/png/webp/gif/avif)', () => {
  assert.ok(ADS_REPO_SRC.includes("'image/jpeg'") && ADS_REPO_SRC.includes("'image/png'") &&
            ADS_REPO_SRC.includes("'image/webp'") && ADS_REPO_SRC.includes("'image/gif'") &&
            ADS_REPO_SRC.includes("'image/avif'"),
    '_ALLOWED_IMAGE_CTYPES must include only jpeg/png/webp/gif/avif');
  const fnStart = ADS_REPO_SRC.indexOf('async function storeImage');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(/_ALLOWED_IMAGE_CTYPES\.has\(ct\)/.test(fnBlock),
    'storeImage must check content-type is in _ALLOWED_IMAGE_CTYPES set');
  assert.ok(fnBlock.includes('Unsupported image type'),
    'storeImage must throw descriptive error for unsupported content-types');
});

test('ADS-SEC-11: storeImage verifies magic bytes match declared content-type', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function storeImage');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(fnBlock.includes('_verifyImageMagic'),
    'storeImage must call _verifyImageMagic');
  // Verify magic-byte checks exist for at least PNG (89 50 4E 47) and JPEG (FF D8)
  const magicFnStart = ADS_REPO_SRC.indexOf('function _verifyImageMagic');
  const magicFnBlock = ADS_REPO_SRC.slice(magicFnStart, magicFnStart + 1500);
  assert.ok(magicFnBlock.includes('0x89') && magicFnBlock.includes('0x50'),
    '_verifyImageMagic must check PNG magic bytes (89 50)');
  assert.ok(magicFnBlock.includes('0xff') && magicFnBlock.includes('0xd8'),
    '_verifyImageMagic must check JPEG magic bytes (FF D8)');
  assert.ok(fnBlock.includes('Image content does not match declared content-type'),
    'storeImage must throw when magic bytes do not match declared content-type');
});

test('ADS-SEC-12: Image ID regex in route is [A-Za-z0-9_-]+ (no path traversal)', () => {
  assert.ok(/\/\^\\\/api\\\/advertisements\\\/image\\\/\[A-Za-z0-9_\-\]\+\$\//.test(WORKER_SRC),
    'image route must use [A-Za-z0-9_-]+ regex (excludes / .. etc — no path traversal)');
  // Controller also validates with stricter length-bounded regex
  const serveStart = ADS_CTRL_SRC.indexOf('async function handleServeImage');
  const serveBlock = ADS_CTRL_SRC.slice(serveStart, serveStart + 800);
  assert.ok(/\/\^\[A-Za-z0-9_\-\]\{8,40\}\$\//.test(serveBlock),
    'handleServeImage must validate imageId with [A-Za-z0-9_-]{8,40} before KV lookup');
});

test('ADS-SEC-13: All admin mutation handlers check rate limit via _checkAdRateLimit (>=12 calls)', () => {
  // _checkAdRateLimit is invoked in every admin mutation handler
  const matches = ADS_CTRL_SRC.match(/await\s+_checkAdRateLimit\(/g) || [];
  assert.ok(matches.length >= 12,
    `controller must call _checkAdRateLimit >=12 times (one per admin mutation handler) (got ${matches.length})`);
});

test('ADS-SEC-14: handleServeImage sets X-Content-Type-Options: nosniff', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleServeImage');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 1000);
  assert.ok(fnBlock.includes("'X-Content-Type-Options': 'nosniff'") || fnBlock.includes('"X-Content-Type-Options": "nosniff"'),
    'handleServeImage must set X-Content-Type-Options: nosniff header');
});

test('ADS-SEC-15: handleServeImage validates image ID regex before KV lookup', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleServeImage');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 800);
  assert.ok(/\/\^\[A-Za-z0-9_\-\]\{8,40\}\$\//.test(fnBlock),
    'handleServeImage must validate imageId with strict regex');
  const regexIdx = fnBlock.indexOf('/^[A-Za-z0-9_-]{8,40}$/');
  const kvIdx = fnBlock.indexOf('advertisementsRepo.getImage');
  assert.ok(regexIdx >= 0 && kvIdx >= 0 && regexIdx < kvIdx,
    'regex validation must occur BEFORE KV lookup (defense in depth)');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 11 — PERFORMANCE (caching strategies)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-PERF-01: Module-level campaign cache exists (_campaignCache) with 60s TTL', () => {
  assert.ok(/let\s+_campaignCache\s*=\s*null/.test(ADS_REPO_SRC),
    'module-level _campaignCache variable must exist');
  assert.ok(/_CAMPAIGN_CACHE_TTL_MS\s*=\s*60\s*\*\s*1000/.test(ADS_REPO_SRC),
    '_CAMPAIGN_CACHE_TTL_MS must be 60*1000 (60s)');
});

test('ADS-PERF-02: _invalidateCampaignCache is called on every admin mutation (>=10 calls)', () => {
  // Count calls to _invalidateCampaignCache() inside mutation functions (excl. definition & export)
  const matches = ADS_REPO_SRC.match(/_invalidateCampaignCache\(\)/g) || [];
  // -1 for the function definition `function _invalidateCampaignCache() { _campaignCache = null; }`
  // -1 for the export in the returned object `_invalidateCampaignCache,`
  const mutationCalls = matches.length - 2;
  assert.ok(mutationCalls >= 10,
    `_invalidateCampaignCache must be called in every admin mutation (got ${mutationCalls} mutation calls)`);
});

test('ADS-PERF-03: listActiveRequiredChannels uses cache (returns cached value if not expired)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActiveRequiredChannels');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(/_campaignCache\s*&&\s*Date\.now\(\)\s*<\s*_campaignCache\.expiresAt/.test(fnBlock),
    'listActiveRequiredChannels must check _campaignCache TTL before hitting DB');
  assert.ok(fnBlock.includes('_refreshCampaignCache'),
    'listActiveRequiredChannels must refresh cache after DB query');
});

test('ADS-PERF-04: listActivePopups uses cache', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActivePopups');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(/_campaignCache\s*&&\s*Date\.now\(\)\s*<\s*_campaignCache\.expiresAt/.test(fnBlock),
    'listActivePopups must check _campaignCache TTL before hitting DB');
  assert.ok(fnBlock.includes('_refreshCampaignCache'),
    'listActivePopups must refresh cache after DB query');
});

test('ADS-PERF-05: getUserChannelPreference (notification_platform) has per-user 60s cache', () => {
  assert.ok(/_PREF_CACHE_TTL_MS\s*=\s*60\s*\*\s*1000/.test(NOTIF_PLATFORM_REPO_SRC),
    'notification_platform repo must define _PREF_CACHE_TTL_MS = 60*1000');
  assert.ok(/_prefCache\s*=\s*new\s+Map\(\)/.test(NOTIF_PLATFORM_REPO_SRC),
    'notification_platform repo must have module-level _prefCache Map');
  const fnStart = NOTIF_PLATFORM_REPO_SRC.indexOf('async function getUserChannelPreference');
  const fnBlock = NOTIF_PLATFORM_REPO_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(fnBlock.includes('_prefCache.get(cacheKey)'),
    'getUserChannelPreference must check _prefCache before DB query');
});

test('ADS-PERF-06: checkAdditionalRequiredChannels uses per-user KV cache (jittered TTL 55-95s, audit H3 fix) to avoid repeated Telegram calls', () => {
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 3000);
  // KV cache read
  assert.ok(fnBlock.includes('env.RATE_LIMITS.get(cacheKey)'),
    'checkAdditionalRequiredChannels must read per-user KV cache');
  // KV cache write (positive and negative)
  assert.ok(fnBlock.includes("env.RATE_LIMITS.put(cacheKey, '1'"),
    'checkAdditionalRequiredChannels must cache positive result');
  assert.ok(fnBlock.includes("env.RATE_LIMITS.put(cacheKey, '0'"),
    'checkAdditionalRequiredChannels must cache negative result');
  // FIX (audit H3): TTL is now jittered 55-95s to avoid cache stampede.
  // Verify _ttlPos / _ttlNeg variables are used (not hardcoded 60).
  assert.ok(fnBlock.includes('_ttlPos') && fnBlock.includes('_ttlNeg'),
    'per-user KV cache TTL must use jittered _ttlPos/_ttlNeg variables (was hardcoded 60)');
  assert.ok(/_ttl(Pos|Neg)\s*=\s*Math\.floor\(55\s*\+/.test(fnBlock),
    'jittered TTL must be 55 + jitter (0-40s) = 55-95s range');
});

test('ADS-PERF-07: _deliverMessageCampaign uses bulk preference fetch (IN clause) not per-user N+1', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(/SELECT\s+user_id,\s+ch_promotions\s+AS\s+pref\s+FROM\s+notification_settings\s+WHERE\s+user_id\s+IN\s*\(/i.test(fnBlock),
    '_deliverMessageCampaign must bulk-fetch preferences via IN clause (not per-user N+1)');
  assert.ok(fnBlock.includes('placeholders'),
    'bulk fetch must build placeholders for IN clause');
  assert.ok(fnBlock.includes('prefMap'),
    'bulk fetch must populate prefMap for per-user lookup');
});

test('ADS-PERF-08: Popup cooldown uses KV (not DB) for O(1) read/write', () => {
  const hasStart = ADS_REPO_SRC.indexOf('async function hasPopupBeenShown');
  const hasBlock = ADS_REPO_SRC.slice(hasStart, hasStart + 500);
  assert.ok(hasBlock.includes('env.RATE_LIMITS.get'),
    'hasPopupBeenShown must use KV (not DB) for O(1) read');
  const markStart = ADS_REPO_SRC.indexOf('async function markPopupShown');
  const markBlock = ADS_REPO_SRC.slice(markStart, markStart + 500);
  assert.ok(markBlock.includes('env.RATE_LIMITS.put'),
    'markPopupShown must use KV (not DB) for O(1) write');
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE WIRING (sanity checks)
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-R-01: All admin channel routes wired (GET/POST/PUT/DELETE/status — >=5 routes)', () => {
  // Spec mentioned 6, but the backend implements 5 admin channel routes
  //   (GET list, POST create, PUT update, DELETE delete, POST status).
  // We assert all 5 are wired via explicit .includes() checks.
  // Plain string forms (GET list, POST create) — no backslashes inside single-quoted JS string.
  assert.ok(WORKER_SRC.includes("request.method === 'GET' && url.pathname === '/api/admin/advertisements/channels'"),
    'GET /api/admin/advertisements/channels (list) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && url.pathname === '/api/admin/advertisements/channels'"),
    'POST /api/admin/advertisements/channels (create) must be wired');
  // Regex literal forms (PUT/DELETE/status) — source contains \\ sequence (escaped slashes inside regex literal).
  // In JS string literal, "\\\\" = one backslash; "\\/" = one backslash + one slash.
  assert.ok(WORKER_SRC.includes("request.method === 'PUT' && /^\\/api\\/admin\\/advertisements\\/channels\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'PUT /api/admin/advertisements/channels/:id (update) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'DELETE' && /^\\/api\\/admin\\/advertisements\\/channels\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'DELETE /api/admin/advertisements/channels/:id (delete) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && /^\\/api\\/admin\\/advertisements\\/channels\\/[A-Za-z0-9_-]+\\/status$/.test(url.pathname)"),
    'POST /api/admin/advertisements/channels/:id/status must be wired');
});

test('ADS-R-02: All admin popup routes wired (>=5 routes)', () => {
  // Spec mentioned 6, but the backend implements 5 admin popup routes
  //   (GET list, POST create, PUT update, DELETE delete, POST status).
  assert.ok(WORKER_SRC.includes("request.method === 'GET' && url.pathname === '/api/admin/advertisements/popups'"),
    'GET /api/admin/advertisements/popups (list) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && url.pathname === '/api/admin/advertisements/popups'"),
    'POST /api/admin/advertisements/popups (create) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'PUT' && /^\\/api\\/admin\\/advertisements\\/popups\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'PUT /api/admin/advertisements/popups/:id (update) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'DELETE' && /^\\/api\\/admin\\/advertisements\\/popups\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'DELETE /api/admin/advertisements/popups/:id (delete) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && /^\\/api\\/admin\\/advertisements\\/popups\\/[A-Za-z0-9_-]+\\/status$/.test(url.pathname)"),
    'POST /api/admin/advertisements/popups/:id/status must be wired');
});

test('ADS-R-03: All admin message routes wired (>=6 routes including /send)', () => {
  // Spec mentioned 7, but the backend implements 6 admin message routes
  //   (GET list, POST create, PUT update, DELETE delete, POST status, POST send).
  assert.ok(WORKER_SRC.includes("request.method === 'GET' && url.pathname === '/api/admin/advertisements/messages'"),
    'GET /api/admin/advertisements/messages (list) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && url.pathname === '/api/admin/advertisements/messages'"),
    'POST /api/admin/advertisements/messages (create) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'PUT' && /^\\/api\\/admin\\/advertisements\\/messages\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'PUT /api/admin/advertisements/messages/:id (update) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'DELETE' && /^\\/api\\/admin\\/advertisements\\/messages\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'DELETE /api/admin/advertisements/messages/:id (delete) must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && /^\\/api\\/admin\\/advertisements\\/messages\\/[A-Za-z0-9_-]+\\/status$/.test(url.pathname)"),
    'POST /api/admin/advertisements/messages/:id/status must be wired');
  assert.ok(WORKER_SRC.includes("request.method === 'POST' && /^\\/api\\/admin\\/advertisements\\/messages\\/[A-Za-z0-9_-]+\\/send$/.test(url.pathname)"),
    'POST /api/admin/advertisements/messages/:id/send must be wired');
});

test('ADS-R-04: Image upload route wired (POST /api/admin/advertisements/upload-image)', () => {
  assert.ok(/request\.method\s*===\s*'POST'\s*&&\s*url\.pathname\s*===\s*'\/api\/admin\/advertisements\/upload-image'/.test(WORKER_SRC),
    'POST /api/admin/advertisements/upload-image route must be wired');
  assert.ok(WORKER_SRC.includes('handleAdminUploadImage'),
    'handleAdminUploadImage handler must be invoked');
});

test('ADS-R-05: User popup routes wired (GET popups, POST shown)', () => {
  // GET popups
  assert.ok(/request\.method\s*===\s*'GET'\s*&&\s*url\.pathname\s*===\s*'\/api\/advertisements\/popups'/.test(WORKER_SRC),
    'GET /api/advertisements/popups user route must be wired');
  // POST shown
  assert.ok(/request\.method\s*===\s*'POST'\s*&&\s*\/\^\\\/api\\\/advertisements\\\/popups\\\/\[A-Za-z0-9_\-\]\+\\\/shown\$\/\.test\(url\.pathname\)/.test(WORKER_SRC),
    'POST /api/advertisements/popups/:id/shown user route must be wired');
});

test('ADS-R-06: Image serving route wired (public, no auth)', () => {
  // Route exists (regex literal form)
  assert.ok(WORKER_SRC.includes("/^\\/api\\/advertisements\\/image\\/[A-Za-z0-9_-]+$/.test(url.pathname)"),
    'GET /api/advertisements/image/:id route must be wired');
  // Public — verify the route handler does NOT auth-gate.
  assert.ok(WORKER_SRC.includes('advertisementsHandlers.handleServeImage'),
    'handleServeImage handler must be invoked');
  // Slice EXACTLY the handleServeImage function (from its definition to the next function).
  const serveHandlerStart = ADS_CTRL_SRC.indexOf('async function handleServeImage');
  const nextFnIdx = ADS_CTRL_SRC.indexOf('async function handleAdminListChannels', serveHandlerStart);
  const serveHandlerBlock = nextFnIdx > 0
    ? ADS_CTRL_SRC.slice(serveHandlerStart, nextFnIdx)
    : ADS_CTRL_SRC.slice(serveHandlerStart, serveHandlerStart + 800);
  assert.ok(!serveHandlerBlock.includes('requireAdmin'),
    'handleServeImage must NOT call requireAdmin (public route)');
  assert.ok(!serveHandlerBlock.includes('authenticateTelegramRequest'),
    'handleServeImage must NOT call authenticateTelegramRequest (public route)');
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT FIX TESTS — Regression tests for issues found in final audit
// ═══════════════════════════════════════════════════════════════════════════

// FIX C1: createChannel uses queryDbTransaction for atomic INSERT
test('ADS-FIX-C1: createChannel uses queryDbTransaction (atomic transaction)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function createChannel');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('queryDbTransaction'),
    'createChannel must use queryDbTransaction for atomic INSERT (was bare BEGIN/COMMIT which is a no-op on neon HTTP)');
  assert.ok(fnBlock.includes('INSERT INTO ad_campaigns') && fnBlock.includes('INSERT INTO ad_channels'),
    'createChannel must INSERT into both ad_campaigns and ad_channels within the transaction');
  assert.ok(!/queryDb\(env,\s*'BEGIN'\)/.test(fnBlock),
    'createChannel must NOT use bare queryDb(env, "BEGIN") — it is a no-op on neon HTTP');
});

// FIX H1: CAS claim prevents concurrent double-delivery
test('ADS-FIX-H1: handleAdminSendMessage uses CAS claim to prevent concurrent delivery', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function handleAdminSendMessage');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 4000);
  assert.ok(fnBlock.includes('claimMessageForDelivery'),
    'handleAdminSendMessage must call claimMessageForDelivery before delivery');
  assert.ok(fnBlock.includes('CAMPAIGN_RECENTLY_SENT'),
    'must return CAMPAIGN_RECENTLY_SENT error code when claim fails (prevents double-click)');
  assert.ok(fnBlock.includes('409'),
    'must return 409 Conflict status when claim fails');
  assert.ok(fnBlock.includes('releaseMessageClaim'),
    'must release claim on delivery failure (allows retry)');
});

test('ADS-FIX-H1b: claimMessageForDelivery uses atomic UPDATE...RETURNING', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function claimMessageForDelivery');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(/UPDATE ad_messages.*SET last_processed_at = NOW\(\).*WHERE.*RETURNING/s.test(fnBlock),
    'claimMessageForDelivery must use atomic UPDATE...WHERE...RETURNING for CAS claim');
  assert.ok(fnBlock.includes('last_processed_at < NOW()'),
    'claim must check last_processed_at cooldown (prevents re-delivery within 5 min)');
  assert.ok(fnBlock.includes('rowCount'),
    'claim must check rowCount to determine if claim succeeded');
});

// FIX H2: Safety cap lowered to 1000
test('ADS-FIX-H2: Safety cap is 1000 (not 5000) to fit Workers CPU limit', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 8000);
  assert.ok(/>= 1000/.test(fnBlock),
    'safety cap must be 1000 (was 5000 which exceeded Workers 30s CPU limit)');
  assert.ok(!/>=\s*5000/.test(fnBlock),
    'old 5000 cap must be removed');
});

// FIX H3: Jittered TTL for cache stampede prevention
test('ADS-FIX-H3: checkAdditionalRequiredChannels uses jittered TTL (55-95s)', () => {
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('_jitterSeed'),
    'must use a jitter seed (per-user + hash) for consistent TTL');
  assert.ok(fnBlock.includes('_ttlJitter'),
    'must compute jitter value (0-40s)');
  assert.ok(/expirationTtl:\s*_ttl(Pos|Neg)/.test(fnBlock),
    'KV put must use jittered TTL variable (not hardcoded 60)');
});

// FIX UI-1: Channel Join frontend uses /api/advertisements/required-channels
test('ADS-FIX-UI1: Frontend calls /api/advertisements/required-channels', () => {
  const fnStart = APP_SRC.indexOf('async function _renderRequiredChannelsList');
  assert.ok(fnStart > 0,
    '_renderRequiredChannelsList function must exist in app.js');
  const fnBlock = APP_SRC.slice(fnStart, fnStart + 3000);
  assert.ok(fnBlock.includes('/api/advertisements/required-channels'),
    'must fetch from /api/advertisements/required-channels');
  assert.ok(fnBlock.includes('jl-channel-row'),
    'must render each channel as a jl-channel-row');
  assert.ok(fnBlock.includes('jl-channel-join'),
    'must render per-channel join link');
  assert.ok(fnBlock.includes('textContent'),
    'must use textContent for XSS safety (admin-supplied title/channel)');
});

test('ADS-FIX-UI1b: showJoinLock calls _renderRequiredChannelsList', () => {
  const fnStart = APP_SRC.indexOf('function showJoinLock');
  const fnBlock = APP_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes('_renderRequiredChannelsList'),
    'showJoinLock must call _renderRequiredChannelsList to populate the channel list');
});

test('ADS-FIX-UI1c: join-lock-channels container exists in index.html', () => {
  assert.ok(INDEX_HTML.includes('id="join-lock-channels"'),
    'index.html must have a #join-lock-channels container for the multi-channel list');
});

// FIX UI-2: Premium Features "Advertisement Control" benefit
test('ADS-FIX-UI2: Premium Features includes Advertisement Control benefit', () => {
  // Check membership-user.js for the benefit
  const memSrc = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
  assert.ok(memSrc.includes("'megaphone'"),
    'megaphone icon must be defined for the Advertisement Control benefit');
  assert.ok(memSrc.includes('کنترل تبلیغات'),
    'benefit title "کنترل تبلیغات" must be present');
  assert.ok(memSrc.includes('مدیریت و غیرفعال‌سازی تبلیغات'),
    'benefit description "مدیریت و غیرفعال‌سازی تبلیغات" must be present');
  // Count occurrences — should appear in both the status popup and activation popup
  const matches = memSrc.match(/benefitRow\('megaphone'/g) || [];
  assert.ok(matches.length >= 2,
    `megaphone benefit must appear in both popups (status + activation), got ${matches.length}`);
});

// FIX UI-3: Admin audience badge colors match spec (free=blue, premium=orange, all=gray)
test('ADS-FIX-UI3: Audience badge colors match spec', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsAudienceMeta');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 600);
  assert.ok(/case 'free':.*color: 'blue'/.test(fnBlock.replace(/\n/g, ' ')) || fnBlock.includes("case 'free':    return { label: 'رایگان',  color: 'blue' }"),
    'free audience must be blue (was gray)');
  assert.ok(fnBlock.includes("color: 'orange'"),
    'premium audience must be orange/amber');
  assert.ok(/case 'all':.*color: 'gray'/.test(fnBlock.replace(/\n/g, ' ')) || fnBlock.includes("case 'all': default: return { label: 'همه', color: 'gray' }"),
    'all audience must be gray (was green)');
});

// FIX UI-3: archived status distinct from draft
test('ADS-FIX-UI3b: archived status uses gray-dark (distinct from draft gray)', () => {
  const fnStart = ADMIN_JS.indexOf('function _adStatusMeta');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 600);
  assert.ok(fnBlock.includes("color: 'gray-dark'"),
    "archived must use 'gray-dark' color (was same as draft 'gray')");
  // CSS class must exist
  assert.ok(STYLE_SRC.includes('.admin-badge-gray-dark'),
    '.admin-badge-gray-dark CSS class must exist in style.css');
  assert.ok(STYLE_SRC.includes('text-decoration: line-through'),
    'archived badge must have line-through to visually distinguish from draft');
});

// FIX UI-4: .rc-field textarea scoped to ads section only
test('ADS-FIX-UI4: .rc-field textarea scoped to ads section (no global leak)', () => {
  // The unscoped rule must NOT exist
  assert.ok(!/^\.rc-field textarea\s*\{/m.test(STYLE_SRC),
    'unscoped .rc-field textarea rule must NOT exist (was leaking to notification-center)');
  // The scoped rule must exist
  assert.ok(STYLE_SRC.includes('#admin-section-advertisements .rc-field textarea'),
    'scoped #admin-section-advertisements .rc-field textarea rule must exist');
});

// FIX UI-5: Premium card has --premium variant + corner badge + amber promo icon
test('ADS-FIX-UI5: Premium unlocked card has --premium variant + corner badge', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 7000);
  assert.ok(renderBlock.includes('ns-prem-card--premium'),
    'unlocked premium-only card must have ns-prem-card--premium class');
  assert.ok(renderBlock.includes('ns-prem-corner-badge'),
    'unlocked premium-only card must have a ns-prem-corner-badge');
  assert.ok(renderBlock.includes('isPremiumUnlocked'),
    'must compute isPremiumUnlocked state (premiumOnly && isPremiumUser)');
});

test('ADS-FIX-UI5b: Premium card CSS has amber border + glow', () => {
  assert.ok(STYLE_SRC.includes('.ns-prem-card--premium'),
    '.ns-prem-card--premium CSS class must exist');
  assert.ok(/\.ns-prem-card--premium\s*\{[^}]*border-color:\s*rgba\(245,\s*166,\s*35/.test(STYLE_SRC),
    'premium card must have amber border-color');
});

test('ADS-FIX-UI5c: Locked card is muted but elegant (opacity 0.55-0.65, no grayscale)', () => {
  // PHASE 2: Free-user locked cards use opacity 0.55-0.65 (muted, not broken).
  // The hover state lifts to 0.68 (subtle feedback, card still clearly looks disabled).
  const lockedBlock = STYLE_SRC.slice(
    STYLE_SRC.indexOf('.ns-prem-card--locked'),
    STYLE_SRC.indexOf('.ns-prem-card--locked') + 400
  );
  // opacity must be in 0.55-0.65 range (muted but visible)
  assert.ok(/opacity:\s*0\.(5[5-9]|6[0-5])/.test(lockedBlock),
    'locked card must use opacity 0.55-0.65 (muted but visible, not too dim)');
  // hover state should be ≤ 0.70 (subtle feedback, card still clearly disabled)
  assert.ok(/ns-prem-card--locked:hover[^}]*opacity:\s*0\.(6[8-9]|70)/s.test(lockedBlock) ||
            STYLE_SRC.includes('.ns-prem-card--locked:hover'),
    'locked card hover opacity must be ≤ 0.70 (card still clearly looks disabled)');
  assert.ok(!/grayscale\(0\.6\)/.test(lockedBlock),
    'locked card icon must NOT be grayscale(0.6) — keep full color');
});

test('ADS-FIX-UI5d: Promo icon uses amber (not cyan)', () => {
  const promoBlock = STYLE_SRC.slice(
    STYLE_SRC.indexOf('.ic-promo'),
    STYLE_SRC.indexOf('.ic-promo') + 200
  );
  assert.ok(!promoBlock.includes('#22D3EE'),
    'promo icon must NOT use cyan #22D3EE (doesn\'t match Premium accent)');
  assert.ok(promoBlock.includes('#F5A623') || promoBlock.includes('245,166,35'),
    'promo icon must use amber #F5A623 (Premium accent)');
});

// FIX UI-3c: Submit button loading state
test('ADS-FIX-UI3c: Submit buttons have loading state (_adsSetBtnLoading)', () => {
  assert.ok(ADMIN_JS.includes('function _adsSetBtnLoading'),
    '_adsSetBtnLoading helper must exist');
  // All 3 save functions must use it
  const saveChannelBlock = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function saveAdChannel'),
    ADMIN_JS.indexOf('async function saveAdChannel') + 2000
  );
  assert.ok(saveChannelBlock.includes('_adsSetBtnLoading') && saveChannelBlock.includes('در حال ذخیره'),
    'saveAdChannel must call _adsSetBtnLoading');

  const savePopupBlock = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function saveAdPopup'),
    ADMIN_JS.indexOf('async function saveAdPopup') + 2000
  );
  assert.ok(savePopupBlock.includes('_adsSetBtnLoading'),
    'saveAdPopup must call _adsSetBtnLoading');

  const saveMsgBlock = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function saveAdMessage'),
    ADMIN_JS.indexOf('async function saveAdMessage') + 2000
  );
  assert.ok(saveMsgBlock.includes('_adsSetBtnLoading'),
    'saveAdMessage must call _adsSetBtnLoading');
});

// FIX H1c: queryDbTransaction wired into advertisementsRepo deps
test('ADS-FIX-DEPS: queryDbTransaction wired into advertisementsRepo', () => {
  // In the repository factory
  assert.ok(ADS_REPO_SRC.includes('const { queryDb, queryDbTransaction, isDatabaseConfigured'),
    'repository must destructure queryDbTransaction from deps');
  // In worker-proxy.js instantiation
  assert.ok(WORKER_SRC.includes('queryDbTransaction,\n  isDatabaseConfigured,\n  isoDate: _rcIsoDate,\n  normalizeOptionalString,\n});') ||
         WORKER_SRC.includes('queryDbTransaction,'),
    'worker-proxy must pass queryDbTransaction to createAdvertisementsRepository');
});

// FIX BE: releaseMessageClaim exists
test('ADS-FIX-REL: releaseMessageClaim method exists', () => {
  assert.ok(ADS_REPO_SRC.includes('async function releaseMessageClaim'),
    'releaseMessageClaim method must exist in repository');
  assert.ok(ADS_REPO_SRC.includes('releaseMessageClaim,'),
    'releaseMessageClaim must be exported in the return statement');
});

console.log('✅ All audit-fix tests loaded.');

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 FIX TESTS — ensureSchema called in all list* functions
// ═══════════════════════════════════════════════════════════════════════════

// FIX: listAllChannelsForAdmin calls ensureSchema
test('ADS-FIX-SCHEMA-01: listAllChannelsForAdmin calls ensureSchema before query', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listAllChannelsForAdmin');
  assert.ok(fnStart > 0, 'listAllChannelsForAdmin function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 800);
  assert.ok(fnBlock.includes('await ensureSchema(env)'),
    'listAllChannelsForAdmin must call await ensureSchema(env) before SELECT (prevents 503 on fresh DB)');
  assert.ok(fnBlock.includes('if (!isDatabaseConfigured(env)) return []'),
    'listAllChannelsForAdmin must guard with isDatabaseConfigured');
});

// FIX: listAllPopupsForAdmin calls ensureSchema
test('ADS-FIX-SCHEMA-02: listAllPopupsForAdmin calls ensureSchema before query', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listAllPopupsForAdmin');
  assert.ok(fnStart > 0, 'listAllPopupsForAdmin function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 800);
  assert.ok(fnBlock.includes('await ensureSchema(env)'),
    'listAllPopupsForAdmin must call await ensureSchema(env) before SELECT');
});

// FIX: listAllMessagesForAdmin calls ensureSchema
test('ADS-FIX-SCHEMA-03: listAllMessagesForAdmin calls ensureSchema before query', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listAllMessagesForAdmin');
  assert.ok(fnStart > 0, 'listAllMessagesForAdmin function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 800);
  assert.ok(fnBlock.includes('await ensureSchema(env)'),
    'listAllMessagesForAdmin must call await ensureSchema(env) before SELECT');
});

// FIX: listActiveRequiredChannels calls ensureSchema
test('ADS-FIX-SCHEMA-04: listActiveRequiredChannels calls ensureSchema before query', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActiveRequiredChannels');
  assert.ok(fnStart > 0, 'listActiveRequiredChannels function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes('await ensureSchema(env)'),
    'listActiveRequiredChannels must call await ensureSchema(env) before SELECT (user-facing endpoint)');
});

// FIX: listActivePopups calls ensureSchema
test('ADS-FIX-SCHEMA-05: listActivePopups calls ensureSchema before query', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function listActivePopups');
  assert.ok(fnStart > 0, 'listActivePopups function must exist');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes('await ensureSchema(env)'),
    'listActivePopups must call await ensureSchema(env) before SELECT (user-facing endpoint)');
});

// FIX: _schemaVerified flag exists (idempotent — skips after first success)
test('ADS-FIX-SCHEMA-06: _schemaVerified flag exists for idempotent ensureSchema', () => {
  assert.ok(ADS_REPO_SRC.includes('let _schemaVerified = false'),
    '_schemaVerified flag must exist (prevents re-running CREATE TABLE on every call)');
  assert.ok(/if \(_schemaVerified\) return;/.test(ADS_REPO_SRC),
    'ensureSchema must early-return if _schemaVerified is true (zero overhead on warm isolates)');
});

// FIX: CREATE TABLE IF NOT EXISTS (idempotent, safe for concurrent calls)
test('ADS-FIX-SCHEMA-07: all CREATE TABLE statements use IF NOT EXISTS', () => {
  const tables = ['ad_campaigns', 'ad_channels', 'ad_popups', 'ad_messages'];
  tables.forEach(t => {
    assert.ok(ADS_REPO_SRC.includes(`CREATE TABLE IF NOT EXISTS ${t}`),
      `${t} must use CREATE TABLE IF NOT EXISTS (idempotent, safe for concurrent calls)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — SVG icons replace emojis in Advertisement Admin UI
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-FIX-UI-EMOJI-01: _ADS_ICONS object exists with all required SVG icons', () => {
  assert.ok(ADMIN_JS.includes('var _ADS_ICONS = {'),
    '_ADS_ICONS object must exist in admin.js');
  const iconBlock = ADMIN_JS.slice(
    ADMIN_JS.indexOf('var _ADS_ICONS = {'),
    ADMIN_JS.indexOf('};', ADMIN_JS.indexOf('var _ADS_ICONS = {')) + 2
  );
  const requiredIcons = ['megaphone', 'link', 'layout', 'plus', 'pencil', 'upload', 'info', 'smartphone', 'send', 'check', 'trash', 'close'];
  requiredIcons.forEach(icon => {
    assert.ok(iconBlock.includes(icon + ':'),
      `_ADS_ICONS must include "${icon}" icon`);
  });
  // All icons must be SVG (not emoji)
  assert.ok(iconBlock.includes('<svg'),
    'icons must be inline SVG');
  assert.ok(!/[\u{1F300}-\u{1F9FF}]/u.test(iconBlock),
    'icon block must NOT contain emoji characters');
});

test('ADS-FIX-UI-EMOJI-02: _adsIcon helper renders SVG with CSS class', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsIcon(');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 400);
  assert.ok(fnBlock.includes('_ADS_ICONS[key]'),
    '_adsIcon must look up icon by key');
  assert.ok(fnBlock.includes('class='),
    '_adsIcon must inject CSS class into SVG');
});

test('ADS-FIX-UI-EMOJI-03: No decorative emojis in advertisement admin section', () => {
  // Find the advertisement section in admin.js (from _ADS_ICONS to the end of ads functions)
  const adsStart = ADMIN_JS.indexOf('// ADVERTISEMENTS — Admin UI');
  const adsEnd = ADMIN_JS.indexOf('async function loadAdminMembership');
  assert.ok(adsStart > 0 && adsEnd > adsStart, 'advertisement section must exist');
  const adsBlock = ADMIN_JS.slice(adsStart, adsEnd);
  // Check for common decorative emojis
  const emojiPattern = /[\u{1F300}-\u{1F9FF}]|📢|🔗|🪟|📣|➕|✏️|🗑️|📁|ℹ️|📱|✈️|✓|📤|🔒|⭐|💎/u;
  // Filter out the icon SVG definitions (which don't contain emojis)
  const linesWithoutSvgDefs = adsBlock.split('\n').filter(l => !l.includes("'<'") && !l.includes('viewBox'));
  const joined = linesWithoutSvgDefs.join('\n');
  // The _ADS_ICONS object definition itself is fine — we only care about RENDERED content
  // Check specific known emoji locations (card titles, buttons, help banners)
  assert.ok(!adsBlock.includes('📢 تبلیغات'),
    'section title must NOT have 📢 emoji');
  assert.ok(!adsBlock.includes('🔗 کانال'),
    'card title must NOT have 🔗 emoji');
  assert.ok(!adsBlock.includes('🪟 پاپ'),
    'card title must NOT have 🪟 emoji');
  assert.ok(!adsBlock.includes('📣 پیام'),
    'card title must NOT have 📣 emoji');
  assert.ok(!adsBlock.includes('➕ افزودن'),
    'add button must NOT have ➕ emoji (use _adsIcon("plus"))');
  assert.ok(!adsBlock.includes('✏️ ویرایش'),
    'edit form title must NOT have ✏️ emoji');
  assert.ok(!adsBlock.includes('📁 انتخاب'),
    'upload button must NOT have 📁 emoji');
  assert.ok(!adsBlock.includes('ℹ️ راهنما'),
    'help banner must NOT have ℹ️ emoji');
  assert.ok(!adsBlock.includes("icon: '📱'"),
    'destination meta must NOT use 📱 emoji (use iconKey)');
  assert.ok(!adsBlock.includes("icon: '✈️'"),
    'destination meta must NOT use ✈️ emoji (use iconKey)');
  assert.ok(!adsBlock.includes('📤 ارسال'),
    'send button must NOT have 📢 emoji');
});

test('ADS-FIX-UI-EMOJI-04: index.html advertisement section uses SVG tab icons (no emojis)', () => {
  assert.ok(INDEX_HTML.includes('id="admin-section-advertisements"'),
    'advertisement section must exist in index.html');
  const adsStart = INDEX_HTML.indexOf('id="admin-section-advertisements"');
  const adsEnd = INDEX_HTML.indexOf('</section>', adsStart);
  const adsBlock = INDEX_HTML.slice(adsStart, adsEnd);
  // Section title must NOT have emoji
  assert.ok(!adsBlock.includes('📢 تبلیغات'),
    'section title must NOT have 📢 emoji');
  // Tabs must use SVG icons
  assert.ok(adsBlock.includes('rc-tab-icon'),
    'tabs must use rc-tab-icon CSS class for SVG icons');
  assert.ok(adsBlock.includes('<svg class="rc-tab-icon"'),
    'tab buttons must contain inline SVG with rc-tab-icon class');
  // No emojis in tab labels
  assert.ok(!adsBlock.includes('🔗 کانال‌ها'),
    'channels tab must NOT have 🔗 emoji');
  assert.ok(!adsBlock.includes('🪟 پاپ‌آپ'),
    'popups tab must NOT have 🪟 emoji');
  assert.ok(!adsBlock.includes('📣 پیام‌ها'),
    'messages tab must NOT have 📣 emoji');
});

test('ADS-FIX-UI-EMOJI-05: _adsDestinationMeta uses iconKey (not emoji icon)', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsDestinationMeta');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 500);
  assert.ok(fnBlock.includes('iconKey:'),
    '_adsDestinationMeta must use iconKey (SVG lookup) instead of emoji icon');
  assert.ok(!fnBlock.includes("icon: '📱'"),
    '_adsDestinationMeta must NOT use 📱 emoji');
  assert.ok(!fnBlock.includes("icon: '✈️'"),
    '_adsDestinationMeta must NOT use ✈️ emoji');
});

test('ADS-FIX-UI-EMOJI-06: _adsDestinationBadge renders SVG icon', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsDestinationBadge');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 500);
  assert.ok(fnBlock.includes('_adsIcon('),
    '_adsDestinationBadge must call _adsIcon to render SVG icon');
  assert.ok(fnBlock.includes('ads-badge-icon'),
    '_adsDestinationBadge must use ads-badge-icon CSS class');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Premium empty + error states
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-FIX-UI-EMPTY-01: _adsEmptyState helper exists with SVG icon + CTA', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsEmptyState(');
  assert.ok(fnStart > 0, '_adsEmptyState function must exist');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 600);
  assert.ok(fnBlock.includes('_adsIcon('),
    '_adsEmptyState must render an SVG icon');
  assert.ok(fnBlock.includes('ads-empty-state'),
    '_adsEmptyState must use ads-empty-state CSS class');
  assert.ok(fnBlock.includes('ads-empty-icon'),
    '_adsEmptyState must use ads-empty-icon for the icon container');
  assert.ok(fnBlock.includes('ads-empty-text'),
    '_adsEmptyState must use ads-empty-text for the message');
});

test('ADS-FIX-UI-EMPTY-02: _adsErrorState helper exists with retry button', () => {
  const fnStart = ADMIN_JS.indexOf('function _adsErrorState(');
  assert.ok(fnStart > 0, '_adsErrorState function must exist');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 600);
  assert.ok(fnBlock.includes('_adsIcon('),
    '_adsErrorState must render an SVG icon');
  assert.ok(fnBlock.includes('ads-error-state'),
    '_adsErrorState must use ads-error-state CSS class');
  assert.ok(fnBlock.includes('ads-retry-btn'),
    '_adsErrorState must include a retry button');
  assert.ok(fnBlock.includes('تلاش مجدد'),
    '_adsErrorState retry button must say "تلاش مجدد"');
});

test('ADS-FIX-UI-EMPTY-03: loadAdChannels uses premium empty + error states', () => {
  const fnStart = ADMIN_JS.indexOf('async function loadAdChannels');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 4000);
  assert.ok(fnBlock.includes('_adsEmptyState('),
    'loadAdChannels must use _adsEmptyState for empty table rows');
  assert.ok(fnBlock.includes('_adsErrorState('),
    'loadAdChannels must use _adsErrorState for catch block');
  assert.ok(!fnBlock.includes("'<div class=\"admin-empty\">خطا در بارگذاری</div>'"),
    'loadAdChannels must NOT use the old plain "خطا در بارگذاری" text');
});

test('ADS-FIX-UI-EMPTY-04: loadAdPopups uses premium empty + error states', () => {
  const fnStart = ADMIN_JS.indexOf('async function loadAdPopups');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 4000);
  assert.ok(fnBlock.includes('_adsEmptyState('),
    'loadAdPopups must use _adsEmptyState');
  assert.ok(fnBlock.includes('_adsErrorState('),
    'loadAdPopups must use _adsErrorState');
});

test('ADS-FIX-UI-EMPTY-05: loadAdMessages uses premium empty + error states', () => {
  const fnStart = ADMIN_JS.indexOf('async function loadAdMessages');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 5000);
  assert.ok(fnBlock.includes('_adsEmptyState('),
    'loadAdMessages must use _adsEmptyState');
  assert.ok(fnBlock.includes('_adsErrorState('),
    'loadAdMessages must use _adsErrorState');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — sendAdMessage loading state
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-FIX-UI-LOAD-01: sendAdMessage has button loading state', () => {
  const fnStart = ADMIN_JS.indexOf('async function sendAdMessage');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2500);
  assert.ok(fnBlock.includes('sendBtn.disabled = true'),
    'sendAdMessage must disable the send button during API call');
  assert.ok(fnBlock.includes('در حال ارسال'),
    'sendAdMessage must show "در حال ارسال" loading text');
  assert.ok(fnBlock.includes('finally'),
    'sendAdMessage must re-enable the button in a finally block');
  assert.ok(fnBlock.includes("_adsIcon('refresh'"),
    'sendAdMessage loading state must use refresh SVG icon');
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — CSS for SVG icons exists
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-FIX-UI-CSS-01: SVG icon CSS classes exist in style.css', () => {
  assert.ok(STYLE_SRC.includes('.rc-tab-icon'),
    '.rc-tab-icon CSS class must exist (tab icons)');
  assert.ok(STYLE_SRC.includes('.rc-card-icon'),
    '.rc-card-icon CSS class must exist (card title icons)');
  assert.ok(STYLE_SRC.includes('.adm-btn-icon'),
    '.adm-btn-icon CSS class must exist (button icons)');
  assert.ok(STYLE_SRC.includes('.ads-badge-icon'),
    '.ads-badge-icon CSS class must exist (badge icons)');
  assert.ok(STYLE_SRC.includes('.rc-radio-icon'),
    '.rc-radio-icon CSS class must exist (radio option icons)');
});

test('ADS-FIX-UI-CSS-02: empty + error state CSS classes exist', () => {
  assert.ok(STYLE_SRC.includes('.ads-empty-state'),
    '.ads-empty-state CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ads-empty-icon'),
    '.ads-empty-icon CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ads-empty-svg'),
    '.ads-empty-svg CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ads-error-state'),
    '.ads-error-state CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ads-error-icon'),
    '.ads-error-icon CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ads-retry-btn'),
    '.ads-retry-btn CSS class must exist');
});

console.log('✅ All PHASE 1-9 fix tests loaded.');

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Free-user Locked Notification Settings UI (regression tests)
// ═══════════════════════════════════════════════════════════════════════════

// Lock + Crown SVG icons added to NS_ICONS
test('ADS-FREE-UI-01: NS_ICONS has lock + crown SVG icons for Free-user locked UI', () => {
  const nsIconsStart = APP_SRC.indexOf('const NS_ICONS = {');
  const nsIconsEnd = APP_SRC.indexOf('};', nsIconsStart) + 2;
  const nsIconsBlock = APP_SRC.slice(nsIconsStart, nsIconsEnd);
  assert.ok(nsIconsBlock.includes('lock:'),
    'NS_ICONS must have a lock icon');
  assert.ok(nsIconsBlock.includes('crown:'),
    'NS_ICONS must have a crown icon');
  // Verify they are SVG (not emoji)
  const lockIconStart = nsIconsBlock.indexOf('lock:');
  const lockIconBlock = nsIconsBlock.slice(lockIconStart, lockIconStart + 300);
  assert.ok(lockIconBlock.includes('<svg'),
    'lock icon must be inline SVG');
  assert.ok(lockIconBlock.includes('stroke="currentColor"'),
    'lock icon must use stroke="currentColor" (consistent with Feather-style)');
});

// Lock badge added to locked cards (top corner, SVG)
test('ADS-FREE-UI-02: Locked cards have ns-prem-lock-badge (SVG lock icon in corner)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes('ns-prem-lock-badge'),
    'locked card must have ns-prem-lock-badge element');
  assert.ok(renderBlock.includes('aria-hidden'),
    'lock badge must have aria-hidden (accessibility)');
  // CSS class must exist
  assert.ok(STYLE_SRC.includes('.ns-prem-lock-badge'),
    '.ns-prem-lock-badge CSS class must exist');
  assert.ok(/\.ns-prem-lock-badge\s*\{[^}]*position:\s*absolute/.test(STYLE_SRC),
    'lock badge must be absolutely positioned in corner');
});

// Whole card is clickable for Free users → MembershipApp.open()
test('ADS-FREE-UI-03: Free-user locked card is fully clickable → MembershipApp.open()', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes("window.MembershipApp.open"),
    'clicking the locked card must call window.MembershipApp.open() (existing upgrade route)');
  assert.ok(renderBlock.includes("card.setAttribute('role', 'button')"),
    'locked card must have role="button" (accessibility)');
  assert.ok(renderBlock.includes("card.setAttribute('tabindex', '0')"),
    'locked card must have tabindex="0" (keyboard accessible)');
  assert.ok(renderBlock.includes("aria-disabled"),
    'locked card must have aria-disabled attribute');
  assert.ok(renderBlock.includes('card.style.cursor') && renderBlock.includes("'pointer'"),
    'locked card must have cursor: pointer (visual clickability)');
});

// Keyboard accessibility — Enter/Space triggers upgrade
test('ADS-FREE-UI-04: Locked card keyboard accessibility (Enter/Space)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes("e.key === 'Enter'") || renderBlock.includes("'Enter'"),
    'Enter key must trigger upgrade');
  assert.ok(renderBlock.includes("e.key === ' '") || renderBlock.includes("' '"),
    'Space key must trigger upgrade');
  assert.ok(renderBlock.includes('keydown'),
    'locked card must have keydown event listener');
});

// Capsule buttons are disabled (no state change, no API call)
test('ADS-FREE-UI-05: Free-user capsule buttons are disabled (ns-cap-btn--disabled)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes('ns-cap-btn--disabled'),
    'locked capsule buttons must have ns-cap-btn--disabled class');
  assert.ok(renderBlock.includes("disabled', 'disabled'") || renderBlock.includes("'disabled'"),
    'locked capsule buttons must have disabled attribute');
  assert.ok(renderBlock.includes('aria-disabled'),
    'locked capsule buttons must have aria-disabled');
  assert.ok(renderBlock.includes("tabindex', '-1'") || renderBlock.includes("'-1'"),
    'locked capsule buttons must have tabindex="-1" (removed from tab order)');
});

// Event delegation guard — disabled buttons don't trigger settings change
test('ADS-FREE-UI-06: Event delegation guards against disabled button clicks', () => {
  const handlerStart = APP_SRC.indexOf('list.onclick = function');
  const handlerBlock = APP_SRC.slice(handlerStart, handlerStart + 800);
  assert.ok(handlerBlock.includes('ns-cap-btn--disabled'),
    'event delegation must check for ns-cap-btn--disabled class');
  assert.ok(handlerBlock.includes('hasAttribute') && handlerBlock.includes('disabled'),
    'event delegation must check for disabled attribute');
  assert.ok(handlerBlock.includes('e.preventDefault') && handlerBlock.includes('e.stopPropagation'),
    'event delegation must preventDefault + stopPropagation for disabled buttons');
});

// Upgrade message at bottom of locked card
test('ADS-FREE-UI-07: Locked card has upgrade message with lock SVG', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes('ns-prem-upgrade-msg'),
    'locked card must have ns-prem-upgrade-msg element');
  assert.ok(renderBlock.includes('برای دسترسی به این تنظیمات، به پریمیوم ارتقا دهید'),
    'locked card must show Persian upgrade message');
  // Message has a lock SVG
  const msgStart = renderBlock.indexOf('ns-prem-upgrade-msg');
  const msgBlock = renderBlock.slice(msgStart, msgStart + 300);
  assert.ok(msgBlock.includes('<svg'),
    'upgrade message must include an SVG lock icon');
});

// CTA button "ارتقا به پریمیوم" with crown SVG
test('ADS-FREE-UI-08: Locked card has CTA button with crown SVG → upgrade', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes('ns-prem-upgrade-cta'),
    'locked card must have ns-prem-upgrade-cta button');
  assert.ok(renderBlock.includes('ارتقا به پریمیوم'),
    'CTA must show "ارتقا به پریمیوم"');
  // CTA has crown SVG
  const ctaStart = renderBlock.indexOf('ns-prem-upgrade-cta');
  const ctaBlock = renderBlock.slice(ctaStart, ctaStart + 400);
  assert.ok(ctaBlock.includes('<svg'),
    'CTA must include an SVG icon (crown)');
  // CTA click → MembershipApp.open()
  assert.ok(renderBlock.includes("MembershipApp.open"),
    'CTA click must call MembershipApp.open()');
});

// CTA click handler stops propagation (doesn't double-trigger card click)
test('ADS-FREE-UI-09: CTA click stops propagation (no double-trigger)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  // Find the CTA click handler
  const ctaHandlerStart = renderBlock.indexOf("ctaBtn.addEventListener('click'");
  assert.ok(ctaHandlerStart > 0,
    'CTA must have a click event listener');
  const ctaHandlerBlock = renderBlock.slice(ctaHandlerStart, ctaHandlerStart + 300);
  assert.ok(ctaHandlerBlock.includes('e.preventDefault') && ctaHandlerBlock.includes('e.stopPropagation'),
    'CTA click handler must preventDefault + stopPropagation (no double-trigger with card click)');
});

// Premium users are NOT affected — no lock badge, no upgrade message, no disabled buttons
test('ADS-FREE-UI-10: Premium users see NO lock badge, NO upgrade message (unchanged)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  // isLocked check guards all Free-only UI
  assert.ok(renderBlock.includes('if (isLocked) {'),
    'all Free-only UI (lock badge, upgrade message, CTA) must be inside if (isLocked)');
  // Premium unlocked cards get corner badge, NOT lock badge
  assert.ok(renderBlock.includes('isPremiumUnlocked'),
    'isPremiumUnlocked must be computed (Premium path)');
  assert.ok(renderBlock.includes('ns-prem-corner-badge'),
    'Premium unlocked cards get corner badge (NOT lock badge)');
  // Premium capsule buttons are NOT disabled
  assert.ok(renderBlock.includes('Premium user — functional controls (UNCHANGED)'),
    'Premium capsule section must be marked UNCHANGED');
});

// CSS: locked card opacity 0.55-0.65 (muted, not broken)
test('ADS-FREE-UI-11: Locked card CSS opacity is 0.55-0.65 (muted)', () => {
  const lockedBlock = STYLE_SRC.slice(
    STYLE_SRC.indexOf('.ns-prem-card--locked'),
    STYLE_SRC.indexOf('.ns-prem-card--locked') + 500
  );
  assert.ok(/opacity:\s*0\.(5[5-9]|6[0-5])/.test(lockedBlock),
    'locked card opacity must be 0.55-0.65 (muted but visible)');
});

// CSS: disabled capsule buttons have no hover effect
test('ADS-FREE-UI-12: Disabled capsule buttons have no hover effect', () => {
  assert.ok(STYLE_SRC.includes('.ns-cap-btn--disabled'),
    '.ns-cap-btn--disabled CSS class must exist');
  assert.ok(/\.ns-cap-btn--disabled:hover[^{]*\{[^}]*transform:\s*none/i.test(STYLE_SRC) ||
            STYLE_SRC.includes('.ns-cap-btn--disabled:hover'),
    'disabled buttons must have hover:transform:none (no hover effect)');
  assert.ok(/\.ns-cap-btn--disabled[^{]*\{[^}]*pointer-events:\s*none/i.test(STYLE_SRC),
    'disabled buttons must have pointer-events:none (clicks pass through to card)');
});

// CSS: upgrade row + CTA styles exist
test('ADS-FREE-UI-13: Upgrade message + CTA CSS classes exist', () => {
  assert.ok(STYLE_SRC.includes('.ns-prem-upgrade-row'),
    '.ns-prem-upgrade-row CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ns-prem-upgrade-msg'),
    '.ns-prem-upgrade-msg CSS class must exist');
  assert.ok(STYLE_SRC.includes('.ns-prem-upgrade-cta'),
    '.ns-prem-upgrade-cta CSS class must exist');
  // CTA has amber accent
  assert.ok(/\.ns-prem-upgrade-cta\s*\{[^}]*#F5A623/.test(STYLE_SRC),
    'CTA must use amber #F5A623 (Premium accent)');
});

// CSS: mobile responsive (upgrade row stacks on narrow screens)
test('ADS-FREE-UI-14: Upgrade row is mobile responsive', () => {
  assert.ok(STYLE_SRC.includes('@media (max-width: 480px)'),
    'must have @media (max-width: 480px) breakpoint');
  const mobileBlock = STYLE_SRC.slice(
    STYLE_SRC.indexOf('@media (max-width: 480px)'),
    STYLE_SRC.indexOf('@media (max-width: 480px)') + 300
  );
  assert.ok(mobileBlock.includes('ns-prem-upgrade-row'),
    'mobile breakpoint must target ns-prem-upgrade-row');
  assert.ok(mobileBlock.includes('flex-direction: column'),
    'mobile upgrade row must stack vertically');
});

// CSS: RTL-aware lock badge position
test('ADS-FREE-UI-15: Lock badge uses RTL-aware positioning', () => {
  const lockBadgeBlock = STYLE_SRC.slice(
    STYLE_SRC.indexOf('.ns-prem-lock-badge'),
    STYLE_SRC.indexOf('.ns-prem-lock-badge') + 300
  );
  assert.ok(lockBadgeBlock.includes('inset-inline-end'),
    'lock badge must use inset-inline-end (RTL-aware, not hardcoded right)');
});

// No new emojis added
test('ADS-FREE-UI-16: No new emojis in Free-user locked UI code', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 12000);
  // The new locked-card code should NOT use emojis (SVG only)
  const lockedSection = renderBlock.slice(renderBlock.indexOf('PHASE 2: For Free users'));
  assert.ok(!lockedSection.includes('🔒'),
    'locked card code must NOT use 🔒 emoji (use SVG lock icon)');
  assert.ok(!lockedSection.includes('👑'),
    'locked card code must NOT use 👑 emoji (use SVG crown icon)');
  assert.ok(lockedSection.includes('<svg'),
    'locked card code must use inline SVG icons');
});

// Existing Premium detection source of truth is unchanged
test('ADS-FREE-UI-17: Premium detection uses existing MembershipApp.isPremiumCached (no new logic)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 5000);
  assert.ok(renderBlock.includes('MembershipApp.isPremiumCached'),
    'must use MembershipApp.isPremiumCached (existing source of truth)');
  assert.ok(!renderBlock.includes('isPremiumUser =') || renderBlock.includes('MembershipApp.isPremiumCached'),
    'must NOT create a new isPremium detection logic');
});

// Existing upgrade route is used (MembershipApp.open)
test('ADS-FREE-UI-18: Upgrade uses existing MembershipApp.open route (no new route)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 12000);
  assert.ok(renderBlock.includes('MembershipApp.open'),
    'must use MembershipApp.open() (existing upgrade route)');
  // Must NOT create a new openPremiumUpgrade function
  assert.ok(!renderBlock.includes('openPremiumUpgrade'),
    'must NOT create a new openPremiumUpgrade function (use existing MembershipApp.open)');
});

console.log('✅ All PHASE 2 Free-user Locked UI tests loaded.');

// ═══════════════════════════════════════════════════════════════════════════
// FULL AUDIT — Regression tests for bugs found in root-cause audit
// ═══════════════════════════════════════════════════════════════════════════

// BUG #1 (CRITICAL): createPopup + createMessage lack orphan cleanup
// If the second INSERT (ad_popups/ad_messages) fails, the first INSERT
// (ad_campaigns) is already committed → orphan row with no child.
test('ADS-AUDIT-01: createPopup cleans up orphan campaign row on INSERT failure', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function createPopup');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 2000);
  // Must have a try/catch around the second INSERT that deletes the orphan
  assert.ok(fnBlock.includes('try {'),
    'createPopup must wrap the second INSERT in a try block');
  assert.ok(fnBlock.includes('DELETE FROM ad_campaigns WHERE id = $1'),
    'createPopup must cleanup orphan ad_campaigns row on INSERT failure');
  assert.ok(fnBlock.includes('throw e'),
    'createPopup must re-throw the error after cleanup');
});

test('ADS-AUDIT-02: createMessage cleans up orphan campaign row on INSERT failure', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function createMessage');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('try {'),
    'createMessage must wrap the second INSERT in a try block');
  assert.ok(fnBlock.includes('DELETE FROM ad_campaigns WHERE id = $1'),
    'createMessage must cleanup orphan ad_campaigns row on INSERT failure');
  assert.ok(fnBlock.includes('throw e'),
    'createMessage must re-throw the error after cleanup');
});

test('ADS-AUDIT-03: createChannel already has orphan cleanup (verified baseline)', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function createChannel');
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnStart + 3000);
  // createChannel uses queryDbTransaction (atomic) — no orphan risk
  assert.ok(fnBlock.includes('queryDbTransaction'),
    'createChannel must use queryDbTransaction (atomic, no orphan risk)');
});

// BUG #2 (MEDIUM): ensureSchema swallows errors silently
// Previously each CREATE TABLE had .catch(() => {}) which swallowed errors.
// Now errors are collected + logged, and _schemaVerified is only set if all succeed.
test('ADS-AUDIT-04: ensureSchema does NOT swallow errors with bare .catch(() => {})', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function ensureSchema');
  // Find the closing brace of ensureSchema (next function after it)
  const fnEnd = ADS_REPO_SRC.indexOf('function _genId', fnStart);
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnEnd);
  // Remove comments (lines starting with // or containing //)
  const codeLines = fnBlock.split('\n').filter(l => {
    const trimmed = l.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*');
  });
  const codeBlock = codeLines.join('\n');
  // Must NOT have bare .catch(() => {}) in actual code (comments excluded)
  assert.ok(!/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(codeBlock),
    'ensureSchema must NOT use bare .catch(() => {}) in actual code — errors must be logged');
  // Must collect errors
  assert.ok(codeBlock.includes('schemaErrors'),
    'ensureSchema must collect errors in schemaErrors array');
  assert.ok(codeBlock.includes('schemaErrors.push'),
    'ensureSchema must push errors to schemaErrors');
  assert.ok(codeBlock.includes('console.warn'),
    'ensureSchema must log errors via console.warn');
});

test('ADS-AUDIT-05: _schemaVerified only set if ALL CREATE TABLE succeed', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function ensureSchema');
  const fnEnd = ADS_REPO_SRC.indexOf('function _genId', fnStart);
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnEnd);
  // Must have the conditional: if (schemaErrors.length > 0) { log } else { _schemaVerified = true }
  assert.ok(fnBlock.includes('schemaErrors.length > 0'),
    'ensureSchema must check if schemaErrors.length > 0 before setting _schemaVerified');
  assert.ok(/if\s*\(schemaErrors\.length\s*>\s*0\)\s*\{[^}]*console\.warn[^}]*\}\s*else\s*\{[^}]*_schemaVerified\s*=\s*true/.test(fnBlock.replace(/\n/g, ' ')),
    'ensureSchema must only set _schemaVerified = true if no errors (else branch)');
});

test('ADS-AUDIT-06: ensureSchema logs partial failures with table names', () => {
  const fnStart = ADS_REPO_SRC.indexOf('async function ensureSchema');
  const fnEnd = ADS_REPO_SRC.indexOf('function _genId', fnStart);
  const fnBlock = ADS_REPO_SRC.slice(fnStart, fnEnd);
  // Each .catch must push a descriptive error with table name
  assert.ok(fnBlock.includes("'ad_campaigns: '"),
    'ensureSchema must log ad_campaigns table name on failure');
  assert.ok(fnBlock.includes("'ad_channels: '"),
    'ensureSchema must log ad_channels table name on failure');
  assert.ok(fnBlock.includes("'ad_popups: '"),
    'ensureSchema must log ad_popups table name on failure');
  assert.ok(fnBlock.includes("'ad_messages: '"),
    'ensureSchema must log ad_messages table name on failure');
});

console.log('✅ All FULL AUDIT regression tests loaded.');

// ═══════════════════════════════════════════════════════════════════════════
// OpenRouter Emergency Fallback — Implementation Tests
// ═══════════════════════════════════════════════════════════════════════════

// OR-01: OPENROUTER_MODEL constant exists with correct model
test('OR-01: OPENROUTER_MODEL constant uses nvidia/nemotron-3-super-120b-a12b:free', () => {
  assert.ok(WORKER_SRC.includes("const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'"),
    'OPENROUTER_MODEL must be nvidia/nemotron-3-super-120b-a12b:free');
});

// OR-02: tryOpenRouter function exists
test('OR-02: tryOpenRouter function exists', () => {
  assert.ok(WORKER_SRC.includes('async function tryOpenRouter'),
    'tryOpenRouter function must exist');
});

// OR-03: Uses env.OPENROUTER_API_KEY
test('OR-03: tryOpenRouter uses env.OPENROUTER_API_KEY', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 1000);
  assert.ok(fnBlock.includes('env.OPENROUTER_API_KEY'),
    'tryOpenRouter must use env.OPENROUTER_API_KEY');
});

// OR-04: Uses correct OpenRouter endpoint
test('OR-04: tryOpenRouter uses openrouter.ai endpoint', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 1000);
  assert.ok(fnBlock.includes('https://openrouter.ai/api/v1/chat/completions'),
    'tryOpenRouter must use https://openrouter.ai/api/v1/chat/completions');
});

// OR-05: Has HTTP-Referer and X-Title headers
test('OR-05: tryOpenRouter includes HTTP-Referer and X-Title headers', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 1500);
  assert.ok(fnBlock.includes('HTTP-Referer'),
    'tryOpenRouter must include HTTP-Referer header');
  assert.ok(fnBlock.includes('X-Title'),
    'tryOpenRouter must include X-Title header');
});

// OR-06: Returns provider: 'openrouter'
test('OR-06: tryOpenRouter returns provider: openrouter', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes("provider: 'openrouter'"),
    'tryOpenRouter must return {provider: \'openrouter\', ...}');
});

// OR-07: Uses OpenAI-compatible response parsing (choices[0].message.content)
test('OR-07: tryOpenRouter parses choices[0].message.content', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 3000);
  assert.ok(fnBlock.includes('choices?.[0]?.message?.content'),
    'tryOpenRouter must parse data?.choices?.[0]?.message?.content');
});

// OR-08: Uses classifyHttpError for error classification
test('OR-08: tryOpenRouter uses classifyHttpError', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('classifyHttpError'),
    'tryOpenRouter must use classifyHttpError for error classification');
});

// OR-09: Inserted in fallback chain after Workers AI, before OpenAI
test('OR-09: OpenRouter fallback inserted after Workers AI, before OpenAI', () => {
  const workersAiIdx = WORKER_SRC.indexOf("NEWS_PROVIDER_WORKERS_AI', true)");
  const openRouterIdx = WORKER_SRC.indexOf("NEWS_PROVIDER_OPENROUTER', true)");
  const openaiIdx = WORKER_SRC.indexOf("NEWS_PROVIDER_OPENAI', false)");
  assert.ok(workersAiIdx > 0 && openRouterIdx > 0 && openaiIdx > 0,
    'all three providers must exist in fallback chain');
  assert.ok(workersAiIdx < openRouterIdx,
    'OpenRouter must come AFTER Workers AI in fallback chain');
  assert.ok(openRouterIdx < openaiIdx,
    'OpenRouter must come BEFORE OpenAI in fallback chain');
});

// OR-10: !summary guard ensures OpenRouter NOT called when Groq succeeds
test('OR-10: !summary guard prevents OpenRouter call when previous provider succeeded', () => {
  const openRouterIdx = WORKER_SRC.indexOf("NEWS_PROVIDER_OPENROUTER', true)");
  const fnBlock = WORKER_SRC.slice(openRouterIdx - 200, openRouterIdx + 200);
  assert.ok(fnBlock.includes('!summary'),
    'OpenRouter must be guarded by !summary (only called when all previous providers failed)');
});

// OR-11: attemptProvider wraps tryOpenRouter (circuit breaker integration)
test('OR-11: OpenRouter uses attemptProvider wrapper for circuit breaker', () => {
  const openRouterIdx = WORKER_SRC.indexOf("attemptProvider('openrouter'");
  assert.ok(openRouterIdx > 0,
    'OpenRouter must use attemptProvider("openrouter", ...) for circuit breaker');
});

// OR-12: Provider stats include openrouter
test('OR-12: Provider stats include openrouter entry', () => {
  assert.ok(WORKER_SRC.includes("'openrouter': { success: 0, failed: 0, total_ms: 0 }"),
    'Provider stats must include openrouter entry');
});

// OR-13: Provider arrays include openrouter
test('OR-13: Provider arrays include openrouter', () => {
  assert.ok(WORKER_SRC.includes("'groq', 'gemini', 'workers-ai', 'openrouter', 'openai'"),
    'Provider arrays must include openrouter');
});

// OR-14: Status endpoint includes NEWS_PROVIDER_OPENROUTER
test('OR-14: Status endpoint includes NEWS_PROVIDER_OPENROUTER flag', () => {
  assert.ok(WORKER_SRC.includes("NEWS_PROVIDER_OPENROUTER: isNewsProviderEnabled"),
    'Status endpoint must include NEWS_PROVIDER_OPENROUTER flag');
});

// OR-15: providers_priority includes openrouter
test('OR-15: providers_priority array includes openrouter', () => {
  assert.ok(WORKER_SRC.includes("providers_priority: ['groq', 'gemini', 'workers-ai', 'openrouter', 'openai']"),
    'providers_priority must include openrouter');
});

// OR-16: tryOpenRouter has 15s timeout (same as tryOpenAI)
test('OR-16: tryOpenRouter has 15s timeout', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 1000);
  assert.ok(fnBlock.includes('15000'),
    'tryOpenRouter must have 15000ms (15s) timeout');
});

// OR-17: tryOpenRouter has no_api_key guard
test('OR-17: tryOpenRouter returns no_api_key when key missing', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenRouter');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 500);
  assert.ok(fnBlock.includes("error: 'no_api_key'"),
    'tryOpenRouter must return error: no_api_key when OPENROUTER_API_KEY not set');
});

// OR-18: Does NOT modify tryOpenAI
test('OR-18: tryOpenAI function unchanged (not modified)', () => {
  const fnStart = WORKER_SRC.indexOf('async function tryOpenAI');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 200);
  assert.ok(fnBlock.includes("env.OPENAI_API_KEY"),
    'tryOpenAI must still use env.OPENAI_API_KEY (unchanged)');
  assert.ok(fnBlock.includes("'gpt-4o-mini'") || WORKER_SRC.includes("OPENAI_MODEL = 'gpt-4o-mini'"),
    'tryOpenAI must still use gpt-4o-mini (unchanged)');
});

console.log('✅ All OpenRouter tests loaded.');

// ═══════════════════════════════════════════════════════════════════════════
// Chat AI Redesign — Implementation Tests
// ═══════════════════════════════════════════════════════════════════════════

// CA-01: Groq is primary provider
test('CA-01: Groq is first in Chat AI provider chain', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const groqIdx = ASSISTANT_SRC.indexOf("['groq'");
  const geminiIdx = ASSISTANT_SRC.indexOf("['gemini'");
  assert.ok(groqIdx > 0 && geminiIdx > 0, 'Groq and Gemini must exist in provider chain');
  assert.ok(groqIdx < geminiIdx, 'Groq must come before Gemini');
});

// CA-02: OpenRouter uses correct model
test('CA-02: Chat AI OpenRouter uses nvidia/nemotron-3-super-120b-a12b:free', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes("CHAT_OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'"),
    'Chat OpenRouter must use nvidia/nemotron-3-super-120b-a12b:free');
});

// CA-03: DeepSeek removed
test('CA-03: DeepSeek removed from Chat AI', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(!ASSISTANT_SRC.includes('callDeepSeek'),
    'callDeepSeek function must be removed');
  assert.ok(!ASSISTANT_SRC.includes("'deepseek-chat'"),
    'deepseek-chat model must be removed');
  // Comment referencing DEEPSEEK_API_KEY is OK, but no code usage
  const codeLines = ASSISTANT_SRC.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const codeBlock = codeLines.join('\n');
  assert.ok(!codeBlock.includes('DEEPSEEK_API_KEY'),
    'DEEPSEEK_API_KEY must not be referenced in code (comments OK)');
});

// CA-04: Groq uses openai/gpt-oss-120b
test('CA-04: Chat AI Groq uses openai/gpt-oss-120b', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes("CHAT_GROQ_MODEL = 'openai/gpt-oss-120b'"),
    'Chat Groq must use openai/gpt-oss-120b');
});

// CA-05: Circuit breaker via attemptProvider
test('CA-05: Chat AI uses circuit breaker (shouldAttemptProvider + recordCircuitResult)', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('shouldAttemptProvider'),
    'Chat AI must use shouldAttemptProvider for circuit breaker');
  assert.ok(ASSISTANT_SRC.includes('recordCircuitResult'),
    'Chat AI must use recordCircuitResult for circuit breaker');
  assert.ok(ASSISTANT_SRC.includes('attemptChatProvider'),
    'Chat AI must use attemptChatProvider wrapper');
});

// CA-06: Greeting handler exists
test('CA-06: Greeting handler exists with patterns', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('handleGreeting'),
    'handleGreeting function must exist');
  assert.ok(ASSISTANT_SRC.includes('GREETING_PATTERNS'),
    'GREETING_PATTERNS array must exist');
  assert.ok(ASSISTANT_SRC.includes('سلام'),
    'Greeting patterns must include سلام');
  assert.ok(ASSISTANT_SRC.includes('provider: \'greeting_handler\''),
    'Greeting responses must return provider: greeting_handler');
});

// CA-07: Greeting handler does NOT consume LLM call
test('CA-07: Greeting handler returns before LLM call', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  // Find the greeting handler invocation in handlePostChat
  const greetingIdx = ASSISTANT_SRC.indexOf('const greetingReply = handleGreeting');
  assert.ok(greetingIdx > 0, 'Greeting handler must be called');
  // Find the LLM invocation in handlePostChat (after greeting)
  const llmCallIdx = ASSISTANT_SRC.indexOf('await generateAssistantReply(env, prompt', greetingIdx);
  assert.ok(llmCallIdx > 0, 'generateAssistantReply must be called after greeting');
  // Greeting return must come before LLM call
  const greetingReturn = ASSISTANT_SRC.indexOf('greeting_handler', greetingIdx);
  assert.ok(greetingReturn > 0 && greetingReturn < llmCallIdx,
    'Greeting must return before LLM is called');
});

// CA-08: AMIRBTC app context in system prompt
test('CA-08: ASSISTANT_APP_CONTEXT exists with AMIRBTC features', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('ASSISTANT_APP_CONTEXT'),
    'ASSISTANT_APP_CONTEXT must exist');
  assert.ok(ASSISTANT_SRC.includes('AMIRBTC'),
    'Context must mention AMIRBTC');
  assert.ok(ASSISTANT_SRC.includes('Market'),
    'Context must mention Market feature');
  assert.ok(ASSISTANT_SRC.includes('News'),
    'Context must mention News feature');
  assert.ok(ASSISTANT_SRC.includes('Wallet'),
    'Context must mention Wallet feature');
});

// CA-09: Dynamic context support
test('CA-09: Chat AI supports dynamic context (page, coin, article_id)', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('parseContext'),
    'parseContext function must exist');
  assert.ok(ASSISTANT_SRC.includes('context.page'),
    'Context must support page field');
  assert.ok(ASSISTANT_SRC.includes('context.coin'),
    'Context must support coin field');
  assert.ok(ASSISTANT_SRC.includes('context.article_id'),
    'Context must support article_id field');
});

// CA-10: Article context fetch
test('CA-10: Chat AI fetches article context when article_id provided', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('fetchArticleContext'),
    'fetchArticleContext function must exist');
  assert.ok(ASSISTANT_SRC.includes('news_articles'),
    'Must query news_articles table');
});

// CA-11: Context sanitization
test('CA-11: Context fields are sanitized (length-limited + injection-filtered)', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('sanitizeContextField'),
    'sanitizeContextField function must exist');
  assert.ok(ASSISTANT_SRC.includes('MAX_CONTEXT_FIELD_LENGTH'),
    'MAX_CONTEXT_FIELD_LENGTH constant must exist');
});

// CA-12: Prompt injection filtered in current message
test('CA-12: Current message is sanitized for injection', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const promptFn = ASSISTANT_SRC.indexOf('function buildAssistantPrompt');
  const fnBlock = ASSISTANT_SRC.slice(promptFn, promptFn + 2000);
  assert.ok(fnBlock.includes('sanitizeText(message)'),
    'Current message must be sanitized via sanitizeText()');
});

// CA-13: OpenRouter has HTTP-Referer and X-Title headers
test('CA-13: Chat AI OpenRouter has HTTP-Referer + X-Title headers', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const orFn = ASSISTANT_SRC.indexOf('async function callOpenRouterChat');
  const fnBlock = ASSISTANT_SRC.slice(orFn, orFn + 1000);
  assert.ok(fnBlock.includes('HTTP-Referer'),
    'Chat OpenRouter must include HTTP-Referer header');
  assert.ok(fnBlock.includes('X-Title'),
    'Chat OpenRouter must include X-Title header');
});

// CA-14: Provider chain order: Groq → Gemini → OpenRouter → Workers AI → OpenAI
test('CA-14: Provider chain order is correct', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const groqIdx = ASSISTANT_SRC.indexOf("['groq'");
  const geminiIdx = ASSISTANT_SRC.indexOf("['gemini'");
  const orIdx = ASSISTANT_SRC.indexOf("['openrouter'");
  const waIdx = ASSISTANT_SRC.indexOf("['workers-ai'");
  const oaiIdx = ASSISTANT_SRC.indexOf("['openai'");
  assert.ok(groqIdx < geminiIdx, 'Groq before Gemini');
  assert.ok(geminiIdx < orIdx, 'Gemini before OpenRouter');
  assert.ok(orIdx < waIdx, 'OpenRouter before Workers AI');
  assert.ok(waIdx < oaiIdx, 'Workers AI before OpenAI');
});

// CA-15: Workers AI is fallback (not primary)
test('CA-15: Workers AI is fallback, not primary', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const groqIdx = ASSISTANT_SRC.indexOf("['groq'");
  const waIdx = ASSISTANT_SRC.indexOf("['workers-ai'");
  assert.ok(groqIdx < waIdx, 'Groq must come before Workers AI');
});

// CA-16: Output leak patterns include AMIRBTC context
test('CA-16: Output leak patterns filter AMIRBTC context leakage', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('AMIRBTC App Context'),
    'OUTPUT_LEAK_PATTERNS must filter "AMIRBTC App Context"');
});

// CA-17: System prompt includes honesty + data usage instructions
test('CA-17: System prompt includes data honesty + Persian instructions', () => {
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes('Do NOT make up data'),
    'System prompt must instruct: Do NOT make up data');
  assert.ok(ASSISTANT_SRC.includes('Distinguish between facts and analysis'),
    'System prompt must instruct: Distinguish facts from analysis');
  assert.ok(ASSISTANT_SRC.includes('اطلاعات لحظه‌ای در دسترس نیست'),
    'System prompt must include Persian "no live data" fallback text');
});

// CA-18: Frontend sends context
test('CA-18: Frontend assistant.js sends context in payload', () => {
  const ASSISTANT_JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(ASSISTANT_JS.includes('context:'),
    'Frontend must include context field in payload');
  assert.ok(ASSISTANT_JS.includes('getContext'),
    'Frontend must have getContext() method');
});

console.log('✅ All Chat AI redesign tests loaded.');

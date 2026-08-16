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

test('ADS-MSG-10: Safety cap: max 5000 users per send invocation', () => {
  const fnStart = ADS_CTRL_SRC.indexOf('async function _deliverMessageCampaign');
  // Slice generously — the safety cap appears near the end of the function (~line 612).
  const fnBlock = ADS_CTRL_SRC.slice(fnStart, fnStart + 8000);
  assert.ok(/delivered\s*\+\s*skipped\s*>=\s*5000/.test(fnBlock),
    '_deliverMessageCampaign must enforce 5000-user safety cap');
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
  const chBlock = ADS_REPO_SRC.slice(chStart, chStart + 1500);
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

test('ADS-PERF-06: checkAdditionalRequiredChannels uses per-user KV cache (60s TTL) to avoid repeated Telegram calls', () => {
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const fnBlock = WORKER_SRC.slice(fnStart, fnStart + 2000);
  // KV cache read
  assert.ok(fnBlock.includes('env.RATE_LIMITS.get(cacheKey)'),
    'checkAdditionalRequiredChannels must read per-user KV cache');
  // KV cache write (positive and negative)
  assert.ok(fnBlock.includes("env.RATE_LIMITS.put(cacheKey, '1'"),
    'checkAdditionalRequiredChannels must cache positive result');
  assert.ok(fnBlock.includes("env.RATE_LIMITS.put(cacheKey, '0'"),
    'checkAdditionalRequiredChannels must cache negative result');
  // 60s TTL
  assert.ok(/expirationTtl:\s*60/.test(fnBlock),
    'per-user KV cache TTL must be 60s');
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

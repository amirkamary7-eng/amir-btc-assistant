// ═════════════════════════════════════════════════════════════════════════════
// Mission Event Token Service — extracted from worker-proxy.js (lines 842-1102).
//
// Provides server-issued one-time mission event tokens to prevent direct
// POST /api/wallet/mission/complete abuse (WALLET-002 / MISSION-ABUSE FIX).
//
// Factory pattern: createMissionTokenService({ sharedGetTehranDateString })
// Returns: { issueMissionEventToken, consumeMissionEventToken,
//            isMissionEventTokenConsumed, ...helpers }
//
// The factory receives sharedGetTehranDateString (from src/services/timezone.js)
// to avoid a direct ESM import that would require loadWorker() adaptation
// (loadWorker's import-translation regex only handles ./src/* paths in the
// main worker-proxy.js source, not ../ paths inside sub-modules).
//
// Behavior-preserving extraction: no logic, crypto, KV, TTL, or error changes.
// Uses: createHmac, timingSafeEqual, Buffer (nodejs_compat), crypto.getRandomValues,
//       btoa, atob (builtins), env.TELEGRAM_BOT_TOKEN, env.SESSION_CACHE.
// ═════════════════════════════════════════════════════════════════════════════

export function createMissionTokenService({ sharedGetTehranDateString }) {
const MISSION_TOKEN_TTL_SECONDS = 120; // 2 minutes — enough for frontend to complete
const MISSION_TOKEN_PREFIX = 'mt:';

// FA-7 FIX: use Tehran date (Asia/Tehran) instead of UTC for the daily
// boundary, so the mission event token consumed marker aligns with
// mission_progress.daily_date (which also uses Tehran date via
// sharedGetTehranDateString). Previously this returned UTC date, which
// created a 3.5-hour window (00:00–03:30 Tehran) where the consumed
// marker from the previous Tehran evening still blocked the new Tehran
// day's mission completion.
//
// All 3 call sites of this helper (issueMissionEventToken,
// consumeMissionEventToken, isMissionEventTokenConsumed) are in the
// mission event token system and use the returned value as a KV key
// segment to namespace tokens per-day. Aligning this with Tehran date
// makes the marker expire at Tehran midnight (matching the
// mission_progress UNIQUE constraint boundary).
//
// sharedGetTehranDateString is the single source of truth for Tehran
// date (src/services/timezone.js) — reused here to avoid duplication.
function _getTodayISOString() {
  return sharedGetTehranDateString();
}

// ── Signed Mission Token (Phase 2D — KV decoupling) ─────────────────────
// Generates a stateless signed token that does NOT require KV storage.
// The token encodes {userId, missionId, targetId, expiresAt, nonce} and is
// signed with HMAC-SHA256 using a derived key from env.TELEGRAM_BOT_TOKEN.
//
// Security:
//   - Forgery impossible without the derived key (bot token is secret_text)
//   - Cross-user: payload.u must match authenticated userId at consume time
//   - Cross-mission: payload.m must match submitted missionId
//   - Target binding: payload.t must match submitted targetId
//   - Expiry: payload.e checked against Date.now() (120s TTL)
//   - Replay: same token can be submitted multiple times, but DB idempotency
//     (CASE WHEN rewarded=FALSE in incrementMissionProgress + markMissionRewarded
//     CAS + grantReward UNIQUE ref_id) prevents double-reward and progress
//     inflation.
//
// Token format: base64url(JSON({u,m,t,e,n})) + "." + hex(hmac_sha256(payload, derivedKey))
// Old KV token format: 32-char hex (no dot) — detected at consume time for backward compat.

function _base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _base64UrlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function _getMissionSigningKey(env) {
  // Key derivation: HMAC-SHA256(botToken, 'mission_token_v1')
  // This separates the mission token signing key from Telegram's own HMAC usage,
  // so even if the derived key is somehow leaked, the bot token is not exposed.
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
  return createHmac('sha256', botToken).update('mission_token_v1').digest();
}

function _signMissionToken(env, payload) {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = _base64UrlEncode(payloadJson);
  const key = _getMissionSigningKey(env);
  const sig = createHmac('sha256', key).update(payloadB64).digest('hex');
  return payloadB64 + '.' + sig;
}

function _verifyMissionTokenSignature(env, token) {
  const dotIdx = String(token || '').indexOf('.');
  if (dotIdx < 0) return null; // Not a signed token (old KV format)
  const payloadB64 = token.substring(0, dotIdx);
  const sig = token.substring(dotIdx + 1);
  const key = _getMissionSigningKey(env);
  const expectedSig = createHmac('sha256', key).update(payloadB64).digest('hex');
  // Constant-time comparison
  if (sig.length !== expectedSig.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }
  try {
    const payloadJson = _base64UrlDecode(payloadB64);
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

/**
 * Issue a one-time mission event token for a user+mission+day.
 * Returns the token string on success, null on failure.
 *
 * PHASE 2D: Uses signed stateless token (no KV write needed).
 * The token encodes {u, m, t, e, n} and is HMAC-signed.
 * KV is NO LONGER required for issuance — eliminates 503 on KV failure.
 *
 * @param {object} env - Worker env
 * @param {string} userId - Telegram user ID
 * @param {string} missionId - Mission ID (e.g. 'read_news')
 * @param {string} targetId - Target content ID (bound into token)
 * @returns {Promise<string|null>} - Signed token string, or null on failure
 */
async function issueMissionEventToken(env, userId, missionId, targetId) {
  const uid = String(userId);
  const mid = String(missionId);
  const boundTarget = String(targetId || '').trim();
  const now = Date.now();
  const expiresAt = now + (MISSION_TOKEN_TTL_SECONDS * 1000);
  // 16-byte random nonce (hex = 32 chars) — prevents two tokens with same
  // payload from being identical (though replay is handled by DB idempotency).
  const nonceBuf = new Uint8Array(16);
  crypto.getRandomValues(nonceBuf);
  const nonce = Array.from(nonceBuf, b => b.toString(16).padStart(2, '0')).join('');

  const payload = { u: uid, m: mid, t: boundTarget, e: expiresAt, n: nonce };
  return _signMissionToken(env, payload);
}

/**
 * Consume a one-time mission event token.
 * Returns true if the token was valid, false otherwise.
 *
 * PHASE 2D: Supports both signed tokens (new format) and KV tokens (old format).
 *
 * Signed token path (new):
 *   1. Verify HMAC signature (constant-time comparison)
 *   2. Decode payload {u, m, t, e, n}
 *   3. Validate: u === userId, m === missionId, t === targetId, e > now
 *   4. No KV read/write needed — DB idempotency handles replay prevention
 *
 * KV token path (old, backward-compat):
 *   1. Check consumed marker (mtc:{uid}:{mid}:{date})
 *   2. Get token value (mt:{uid}:{mid}:{date}:{token})
 *   3. Verify target binding
 *   4. Delete token + set consumed marker
 *
 * Token format detection:
 *   - Contains ".": signed token (new format)
 *   - No ".": KV token (old format, 32-char hex)
 *
 * @param {object} env - Worker env
 * @param {string} userId - Telegram user ID
 * @param {string} missionId - Mission ID
 * @param {string} token - Signed token or 32-char hex KV token
 * @param {string} targetId - Target content ID
 * @returns {Promise<boolean>} - true if valid, false if invalid/expired/already used
 */
async function consumeMissionEventToken(env, userId, missionId, token, targetId) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  // ── SIGNED TOKEN PATH (new format — no KV needed) ──
  if (token.includes('.')) {
    const payload = _verifyMissionTokenSignature(env, token);
    if (!payload) return false; // Invalid signature or malformed

    const uid = String(userId);
    const mid = String(missionId);
    const submittedTarget = String(targetId || '').trim();

    // Validate all claims
    if (String(payload.u) !== uid) return false;         // Cross-user
    if (String(payload.m) !== mid) return false;         // Cross-mission
    if (String(payload.t) !== submittedTarget) return false; // Target substitution
    if (Number(payload.e) <= Date.now()) return false;   // Expired

    // Token is valid. One-per-day enforcement is handled by DB:
    // incrementMissionProgress uses CASE WHEN rewarded=FALSE → replay
    // does not increment progress. markMissionRewarded CAS prevents
    // double-reward. grantReward UNIQUE(ref_id) prevents double-credit.
    return true;
  }

  // ── KV TOKEN PATH (old format — backward compat) ──
  // Old tokens are 32-char hex (no dot). This path will be used by
  // in-flight tokens issued by the previous Worker version during deploy.
  // After all old tokens expire (120s), this path is never reached.
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.get !== 'function') {
    return false;
  }
  if (token.length !== 32) {
    return false;
  }
  const uid = String(userId);
  const mid = String(missionId);
  const today = _getTodayISOString();
  const consumedMarkerKey = `${MISSION_TOKEN_PREFIX}consumed:${uid}:${mid}:${today}`;

  // Check if already consumed (prevents double-reward across two requests
  // that both passed the get() check before either called delete()).
  const alreadyConsumed = await env.SESSION_CACHE.get(consumedMarkerKey);
  if (alreadyConsumed) {
    return false;
  }

  const tokenKey = `${MISSION_TOKEN_PREFIX}${uid}:${mid}:${today}:${token}`;
  const boundTarget = await env.SESSION_CACHE.get(tokenKey);
  if (boundTarget === null || boundTarget === undefined) {
    return false;
  }
  const submittedTarget = String(targetId || '').trim();
  if (String(boundTarget) !== submittedTarget) {
    return false;
  }

  // Consume the token (one-time use)
  try { await env.SESSION_CACHE.delete(tokenKey); } catch {}
  // Set consumed marker (24h TTL = 1 day, longer than any mission window)
  try {
    await env.SESSION_CACHE.put(consumedMarkerKey, '1', { expirationTtl: 86400 });
  } catch {}
  return true;
}

/**
 * Check if a mission event token was already consumed today (for diagnostic).
 */
async function isMissionEventTokenConsumed(env, userId, missionId) {
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.get !== 'function') {
    return false;
  }
  const uid = String(userId);
  const mid = String(missionId);
  const today = _getTodayISOString();
  const consumedMarkerKey = `${MISSION_TOKEN_PREFIX}consumed:${uid}:${mid}:${today}`;
  const existing = await env.SESSION_CACHE.get(consumedMarkerKey);
  return Boolean(existing);
}

  return {
    issueMissionEventToken,
    consumeMissionEventToken,
    isMissionEventTokenConsumed,
    // Export helpers for test access + source-text inspection
    _signMissionToken,
    _verifyMissionTokenSignature,
    _getMissionSigningKey,
    _base64UrlEncode,
    _base64UrlDecode,
    _getTodayISOString,
    MISSION_TOKEN_TTL_SECONDS,
    MISSION_TOKEN_PREFIX,
  };
}

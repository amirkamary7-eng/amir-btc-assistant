// ═════════════════════════════════════════════════════════════════════════════
// News Translation Layer — extracted from worker-proxy.js (lines 4473-4876).
//
// Factory pattern: createNewsTranslator({ readAppCache, writeAppCache,
//   _groqRoutedFetch, EXTERNAL_FETCH_TIMEOUT_MS, validatePersianOutput,
//   isNewsProviderEnabled, shouldAttemptProvider, recordCircuitResult })
// Returns: { isM2m100QuotaExhausted, markM2m100QuotaExhausted,
//            batchTranslateToFarsi, translateToFarsi }
//
// DI dependencies (8):
//   - readAppCache, writeAppCache: KV helpers (for m2m100 quota state)
//   - _groqRoutedFetch: Groq API (for batch translation)
//   - EXTERNAL_FETCH_TIMEOUT_MS: HTTP timeout const
//   - validatePersianOutput: Persian validation (from src/news/shared.js)
//   - isNewsProviderEnabled: provider flag check (from src/news/providers.js)
//     Required because batchTranslateToFarsi and translateToFarsi call
//     isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true) before each
//     Groq attempt. Without this DI dep, the calls throw ReferenceError.
//   - shouldAttemptProvider: circuit-breaker pre-check (from src/news/providers.js)
//     Required because translateToFarsi calls
//     shouldAttemptProvider(env, 'translation-workers-ai') before each m2m100
//     attempt. Without this DI dep, the call throws ReferenceError when the
//     batch path falls back to individual translation.
//   - recordCircuitResult: circuit-breaker state recording (from src/news/providers.js)
//     Required because translateToFarsi calls recordCircuitResult(env, ...) on
//     m2m100 success/failure. The calls are wrapped in try/catch so a missing
//     DI dep would be silently swallowed, but circuit-breaker state would
//     never update (broken observability + incorrect OPEN/CLOSED transitions).
//
// Mutable state (inside factory closure, shared across all callers):
//   - _translationCache (Map): translation memory cache
//   - _m2m100QuotaExhausted (let): daily quota flag
//   - _m2m100QuotaResetAt (let): quota reset timestamp
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createNewsTranslator({
  readAppCache,
  writeAppCache,
  _groqRoutedFetch,
  EXTERNAL_FETCH_TIMEOUT_MS,
  validatePersianOutput,
  isNewsProviderEnabled,
  shouldAttemptProvider,
  recordCircuitResult,
}) {

const _translationCache = new Map();
const TRANSLATION_CACHE_MAX = 500;
const TRANSLATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── m2m100 Daily Quota Suppression (FIX 2) ──────────────────────────
// When Cloudflare Workers AI returns error code 4006 ("daily free allocation
// exhausted"), the quota resets at UTC midnight. Retrying m2m100 for every
// headline in every cron tick wastes subrequests and produces 21+ redundant
// 4006 errors per tick.
//
// This suppression is SEPARATE from the circuit breaker:
//   - Circuit breaker: for transient failures (retryable errors)
//   - Daily quota suppression: for permanent-until-midnight failures (4006)
//
// State: in-memory isolate flag (_m2m100QuotaExhausted + _m2m100QuotaResetAt)
// Plus KV-backed state for cross-isolate propagation.
// Reset: automatically at UTC midnight (calculated from current time).
const M2M100_QUOTA_KV_KEY = 'wai:m2m100:quota_exhausted';
let _m2m100QuotaExhausted = false;
let _m2m100QuotaResetAt = 0; // ms timestamp when quota resets (UTC midnight)

/**
 * Check if m2m100 daily quota is exhausted.
 * Checks in-memory flag first (fast), then KV (for cross-isolate).
 * @returns {Promise<boolean>} true if quota exhausted (skip m2m100)
 */
async function isM2m100QuotaExhausted(env) {
  // Fast path: in-memory check
  if (_m2m100QuotaExhausted && Date.now() < _m2m100QuotaResetAt) {
    return true;
  }
  // Check if reset time has passed
  if (_m2m100QuotaExhausted && Date.now() >= _m2m100QuotaResetAt) {
    _m2m100QuotaExhausted = false;
    _m2m100QuotaResetAt = 0;
    // Don't bother deleting KV — it will expire naturally
  }
  // KV check for cross-isolate propagation
  if (env?.APP_CACHE) {
    try {
      const kvState = await readAppCache(env, M2M100_QUOTA_KV_KEY);
      if (kvState) {
        const parsed = JSON.parse(kvState);
        if (parsed.resetAt && Date.now() < parsed.resetAt) {
          _m2m100QuotaExhausted = true;
          _m2m100QuotaResetAt = parsed.resetAt;
          return true;
        }
      }
    } catch { /* non-fatal */ }
  }
  return false;
}

/**
 * Mark m2m100 daily quota as exhausted.
 * Sets in-memory flag + writes to KV for cross-isolate propagation.
 * Reset time: next UTC midnight.
 */
async function markM2m100QuotaExhausted(env) {
  // Calculate next UTC midnight
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const resetAt = nextMidnight.getTime();
  const ttlSeconds = Math.max(60, Math.floor((resetAt - Date.now()) / 1000));

  _m2m100QuotaExhausted = true;
  _m2m100QuotaResetAt = resetAt;

  if (env?.APP_CACHE) {
    try {
      await writeAppCache(env, M2M100_QUOTA_KV_KEY, JSON.stringify({ resetAt }), ttlSeconds);
    } catch { /* non-fatal */ }
  }
  console.warn(`[TRANSLATE] m2m100 daily quota exhausted (4006). Suppressed until UTC midnight (${new Date(resetAt).toISOString()}). TTL=${ttlSeconds}s`);
}

// ═══════════════════════════════════════════════════════════════════════
// BATCH TRANSLATION — reduces 21 individual Groq calls to 1-2 calls
// ═══════════════════════════════════════════════════════════════════════
// Sends all headlines in a single Groq request, asking for a JSON array
// of Persian translations. Falls back to individual translateToFarsi for
// any translation that fails validation.
//
// This is the single biggest RPM reducer: 21 requests → 1-2 requests.
// ═══════════════════════════════════════════════════════════════════════

const BATCH_TRANSLATION_MAX_BATCH = 10; // Max headlines per single Groq request

/**
 * Batch translate an array of English headlines to Persian.
 * Uses a SINGLE Groq request for up to BATCH_TRANSLATION_MAX_BATCH headlines.
 * Falls back to individual translateToFarsi for any that fail validation.
 *
 * @param {string[]} texts - Array of English text to translate
 * @param {object} env - Worker environment
 * @returns {Promise<Array<{text: string, translation_failed: boolean}>>}
 */
async function batchTranslateToFarsi(texts, env) {
  if (!texts || texts.length === 0) return [];

  const results = new Array(texts.length).fill(null);

  // Process in sub-batches of BATCH_TRANSLATION_MAX_BATCH
  for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_TRANSLATION_MAX_BATCH) {
    const batchTexts = texts.slice(batchStart, batchStart + BATCH_TRANSLATION_MAX_BATCH);
    const batchEnd = Math.min(batchStart + BATCH_TRANSLATION_MAX_BATCH, texts.length);

    // Try batch translation via Groq — DUAL-KEY ROUTED
    let batchSuccess = false;
    let groqResult = null; // P0 FIX: hoisted so 429 check below can access it
    if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true)) {
      const batchPrompt = batchTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
      const batchSystemPrompt = 'You are a professional translator. Translate each English headline to natural Persian (Farsi). Return ONLY a JSON array of strings, where each string is the Persian translation. The array must have exactly the same number of elements as the input. RULES: 1) Output must be 100% Persian — no Chinese/Japanese/Korean (CJK) characters. 2) No English words except crypto symbols (BTC, ETH, USDT) and technical abbreviations (API, AI, ETF). 3) Foreign names must be transliterated: Binance → بایننس, Google → گوگل. 4) Numbers can stay as-is. 5) Return ONLY the JSON array, no other text.';
      const maxTokens = Math.min(4000, batchTexts.length * 200);
      const messages = [
        { role: 'system', content: batchSystemPrompt },
        { role: 'user', content: `Translate these ${batchTexts.length} headlines to Persian. Return a JSON array of ${batchTexts.length} strings:\n\n${batchPrompt}` }
      ];
      // DUAL-KEY: tick-alternating batch routing (batchOffset=0 for translation)
      // _groqRoutedFetch tries preferred key first, falls back to other key on failure
      groqResult = await _groqRoutedFetch(env, batchPrompt, true, 0, 'openai/gpt-oss-120b', messages, maxTokens, 0.3);
      if (groqResult.status_code === 200) {
        const data = JSON.parse(groqResult.response_body);
        const content = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const translations = JSON.parse(jsonMatch[0]);
            if (Array.isArray(translations) && translations.length === batchTexts.length) {
              let allValid = true;
              for (let i = 0; i < translations.length; i++) {
                const translated = String(translations[i] || '').trim();
                if (!translated || translated === batchTexts[i]) { allValid = false; break; }
                const validation = validatePersianOutput(translated, { minLength: 3, minPersianRatio: 0.10 });
                if (!validation.valid && validation.reason !== 'too_short') { allValid = false; break; }
              }
              if (allValid) {
                for (let i = 0; i < translations.length; i++) {
                  results[batchStart + i] = { text: String(translations[i]).trim(), translation_failed: false };
                  _translationCache.set(batchTexts[i], { text: String(translations[i]).trim(), translation_failed: false, _expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS });
                }
                batchSuccess = true;
                console.log(`[BATCH-TRANSLATE] ✅ Batch of ${batchTexts.length} translated in 1 Groq call (key=${groqResult.key_slot})`);
              } else {
                console.warn('[BATCH-TRANSLATE] ⚠️ Some translations failed validation — falling back to individual');
              }
            } else {
              console.warn(`[BATCH-TRANSLATE] ⚠️ Translation count mismatch: expected ${batchTexts.length}, got ${translations?.length}`);
            }
          } catch (parseErr) {
            console.warn('[BATCH-TRANSLATE] ⚠️ JSON parse failed — falling back to individual');
          }
        } else {
          console.warn('[BATCH-TRANSLATE] ⚠️ No JSON array found in response — falling back to individual');
        }
      } else {
        console.warn(`[BATCH-TRANSLATE] ⚠️ Groq batch failed (HTTP ${groqResult.status_code}, keys_tried=${JSON.stringify(groqResult.tried_keys)}) — falling back to individual`);
      }
    }

    // If batch failed (both primary + secondary), fall back to individual translation for this sub-batch
    // P0 FIX: If the batch failed due to Groq 429 (any quota type), do NOT call individual
    // translateToFarsi — each individual call would hit the SAME 429, creating amplification
    // (up to 22 Groq requests for a 10-item batch). Instead, skip directly to the non-Groq
    // fallback path (m2m100 + Google Translate) inside translateToFarsi by setting a flag.
    // The individual translateToFarsi still runs (for non-Groq fallback), but its internal
    // Groq attempt will be skipped because the circuits are OPEN by now.
    const batchGroq429 = groqResult && groqResult.groq_429_info;
    if (batchSuccess) {
      // Batch succeeded — nothing to do
    } else if (batchGroq429) {
      // P0 FIX: Batch failed with Groq 429 — skip individual Groq fallback to prevent amplification.
      // Still run translateToFarsi for the non-Groq fallback path (m2m100/Google Translate),
      // but mark that Groq should be skipped (the circuits are OPEN, so translateToFarsi's
      // internal _groqRoutedFetch will return circuit_open without making a request).
      console.warn(`[BATCH-TRANSLATE] Groq 429 (quota_type=${batchGroq429.quota_type}) — skipping individual Groq fallback to prevent amplification`);
      for (let i = 0; i < batchTexts.length; i++) {
        // translateToFarsi will still try m2m100 + Google Translate (non-Groq fallback).
        // Its internal Groq call will be skipped because circuits are OPEN.
        const result = await translateToFarsi(batchTexts[i], env);
        results[batchStart + i] = result;
      }
    } else {
      // Non-429 batch failure (malformed/invalid AI output) — existing individual fallback
      console.log(`[BATCH-TRANSLATE] Falling back to individual translation for ${batchTexts.length} headlines`);
      for (let i = 0; i < batchTexts.length; i++) {
        const result = await translateToFarsi(batchTexts[i], env);
        results[batchStart + i] = result;
      }
    }
  }

  // Fill any nulls with original text (shouldn't happen, but safety net)
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = { text: texts[i], translation_failed: true };
    }
  }

  return results;
}

async function translateToFarsi(text, env) {
  if (!text) return { text: '', translation_failed: false };

  // OPTIMIZATION: Check in-memory translation cache first.
  // This avoids redundant AI/Google Translate calls for the same text
  // across multiple news refresh cycles.
  // P0-C FIX: Cache now stores { text, translation_failed } objects so that
  // cached results preserve whether the translation actually succeeded.
  // P3-P2-1 FIX: Use full text as cache key (was first 100 chars — collision risk).
  // Map can handle large keys efficiently. Most titles are <150 chars so memory
  // impact is negligible. Eliminates collision risk for long titles sharing prefix.
  const cacheKey = text;
  // P1-1 FIX: Check TTL on cache read — expired entries are treated as cache miss
  if (_translationCache.has(cacheKey)) {
    const cached = _translationCache.get(cacheKey);
    if (cached._expiresAt && Date.now() < cached._expiresAt) {
      // Cache entry is still fresh — return it
      return { text: cached.text, translation_failed: cached.translation_failed };
    }
    // Cache entry expired — remove it and fall through to fresh translation
    _translationCache.delete(cacheKey);
  }

  let result = text;
  let translation_failed = false;

  // ── Groq: DUAL-KEY ROUTED (hash(headline) → Key 0 or Key 1) ──
  // Both keys are active. _groqRoutedFetch tries preferred key, falls back to other.
  if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true)) {
    const indSysPrompt = 'You are a professional translator. Translate the following English text to natural Persian (Farsi). Return ONLY the translation, no explanations or extra text. RULES: 1) Output must be 100% Persian — no Chinese/Japanese/Korean (CJK) characters. 2) No English words except crypto symbols (BTC, ETH, USDT) and technical abbreviations (API, AI, ETF). 3) Foreign names must be transliterated: Binance → بایننس, Google → گوگل, Bitcoin → بیت‌کوین. 4) Numbers can stay as-is.';
    const indMessages = [
      { role: 'system', content: indSysPrompt },
      { role: 'user', content: text }
    ];
    const routedResult = await _groqRoutedFetch(env, text, false, 0, 'openai/gpt-oss-120b', indMessages, 500, 0.3);
    if (routedResult.status_code === 200) {
      const routedData = JSON.parse(routedResult.response_body);
      const routedTranslated = routedData?.choices?.[0]?.message?.content;
      if (routedTranslated && typeof routedTranslated === 'string' && routedTranslated.trim() && routedTranslated.trim() !== text) {
        result = routedTranslated.trim();
        translation_failed = false;
      }
    } else {
      console.warn(`[TRANSLATE] Groq failed (HTTP ${routedResult.status_code}, keys_tried=${JSON.stringify(routedResult.tried_keys)}) — falling back`);
    }
  }

  // ── Fallback 1: Cloudflare Workers AI ─────────────────────────────
  // P0-2 FIX: Circuit Breaker protection for translation. Uses a SEPARATE
  // provider key ('translation-workers-ai') from the summary path's
  // 'workers-ai' because m2m100-1.2b is a different model with different
  // quota limits. When circuit is OPEN, skip Workers AI entirely and fall
  // through to Google Translate (if allowed) or original text.
  if (env?.AI) {
    // FIX 2: Check daily quota suppression BEFORE circuit breaker.
    // If m2m100 returned 4006 earlier today, skip it entirely — no wasted subrequest.
    const m2m100QuotaExhausted = await isM2m100QuotaExhausted(env);
    if (m2m100QuotaExhausted) {
      // Quota exhausted — skip m2m100, fall through to Google Translate
      // (No log here to avoid 21× repetition — the initial 4006 already logged)
    } else {
    const cbTranslation = await shouldAttemptProvider(env, 'translation-workers-ai');
    if (cbTranslation.attempt) {
      try {
        const response = await env.AI.run('@cf/meta/m2m100-1.2b', {
          text,
          source_lang: 'english',
          target_lang: 'persian',
        });
        const translated = response?.translated_text;
        if (translated && typeof translated === 'string' && translated.trim()) {
          result = translated.trim();
          translation_failed = false;
          // SUCCESS — record in circuit breaker
          try { await recordCircuitResult(env, 'translation-workers-ai', true); } catch {}
        } else {
          // Empty response — record as retryable failure
          try { await recordCircuitResult(env, 'translation-workers-ai', false, 'retryable', 'empty_response'); } catch {}
        }
      } catch (e) {
        // AI unavailable or model error — record failure in circuit breaker
        const msg = e?.message || String(e) || '';
        const code = (typeof e?.code === 'number') ? e.code : null;
        // P1-B FIX: Same quota classification as tryWorkersAI.
        const msgHasQuotaError = code === 4006 || code === 3036 || code === 5035
          || /4006|3036|daily.*allocation|daily.*request.*limit|neurons|5035|paid.*plan|upgrade/i.test(msg);
        const isNonRetryable = msgHasQuotaError
          || (/not found|unauthorized|forbidden|invalid (model|binding|argument)/i.test(msg)
              && !/timeout|rate|429|capacity|network|temporarily|overloaded/i.test(msg));
        try { await recordCircuitResult(env, 'translation-workers-ai', false, isNonRetryable ? 'non_retryable' : 'retryable', msg.substring(0, 120)); } catch {}

        // FIX 2: If 4006 (daily quota exhausted), mark for suppression until UTC midnight.
        // This prevents 21× redundant m2m100 calls in the same cron tick + future ticks.
        if (msgHasQuotaError) {
          try { await markM2m100QuotaExhausted(env); } catch {}
        }

        console.warn('[TRANSLATE] m2m100 failed (non-fatal):', e?.message);
      }
    } else {
      // Circuit OPEN — skip Workers AI, fall through to Google Translate
      console.warn('[TRANSLATE] m2m100 circuit OPEN — skipping to Google fallback');
    }
    } // end of m2m100QuotaExhausted else block
  }

  // ── Fallback: Google Translate (unofficial) ───────────────────────
  // P0-2 FIX: Only use Google Translate if Workers AI failed (result still
  // equals input). This prevents flood: when Workers AI circuit is OPEN,
  // we don't blindly send ALL translations to Google — we still try (one
  // request per text), but the in-memory cache + circuit breaker on the
  // Workers AI side limits the overall load. Google Translate has no
  // circuit breaker here (unofficial endpoint, rate limits are IP-based
  // and hard to detect reliably), but the Workers AI circuit prevents
  // the cascade from starting in the first place.
  if (result === text && env?.AI) {
    // Only use Google Translate if AI failed (result still equals input)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t&q=${encodeURIComponent(text)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body?.[0])) {
          const translated = body[0].map((part) => part?.[0] || '').join('').trim();
          if (translated) {
            result = translated;
            translation_failed = false;
          }
        }
      }
    } catch (e) {
      // Both AI and Google failed — return original text
      console.warn('[TRANSLATE] Google fallback failed (non-fatal):', e?.message);
    }
  }

  // P0-C FIX: If result still equals input text, BOTH providers failed.
  // Mark translation_failed=true so callers can exclude the English text
  // from the Farsi news feed (instead of silently serving English as Farsi).
  if (result === text) {
    translation_failed = true;
  }

  // PHASE 5 FIX: Validate that the translation output is actually Persian.
  // Previously, translateToFarsi only checked if the result was non-empty and
  // different from the input — it did NOT verify the output was Persian. This
  // meant Chinese/English output from m2m100 or Google Translate would be
  // silently accepted and served as "Farsi" news titles.
  //
  // We use validatePersianOutput with LOWER thresholds than the summary path
  // (minLength=200) because news titles are short (typically 30-100 chars):
  //   - minLength: 3 (reject empty/malformed)
  //   - minPersianRatio: 0.10 (lower — short titles with many tickers)
  //   - maxCjkRatio: 0.05 (reject Chinese contamination)
  //   - maxAsciiLetterRatio: 0.80 (higher — allows "Bitcoin ETF تایید شد")
  //
  // If the translation fails validation (Chinese/English/malformed), we treat
  // it as a failed translation (translation_failed=true) and return the
  // original text. This prevents non-Persian output from reaching the Farsi
  // news feed.
  if (!translation_failed && result !== text) {
    const translationValidation = validatePersianOutput(result, {
      minLength: 3,
      minPersianRatio: 0.10,
      maxCjkRatio: 0.05,
      maxAsciiLetterRatio: 0.80,
    });
    if (!translationValidation.valid) {
      console.warn('[TRANSLATE] Output failed Persian validation — treating as failed:', {
        reason: translationValidation.reason,
        persianRatio: translationValidation.stats?.persianRatio,
        cjkRatio: translationValidation.stats?.cjkRatio,
        length: translationValidation.stats?.totalChars,
      });
      translation_failed = true;
      result = text; // revert to original English text
    }
  }

  const cacheEntry = { text: result, translation_failed, _expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS };

  // Cache the result (even on failure — avoids retrying failed translations)
  // P1-1 FIX: Entries now have _expiresAt (5 min TTL). Expired entries are
  // evicted on read (lazy eviction) or by LRU when cache is full.
  if (_translationCache.size >= TRANSLATION_CACHE_MAX) {
    // Evict oldest entry (first key in Map insertion order)
    const firstKey = _translationCache.keys().next().value;
    _translationCache.delete(firstKey);
  }
  _translationCache.set(cacheKey, cacheEntry);

  return cacheEntry;
}

  return {
    isM2m100QuotaExhausted,
    markM2m100QuotaExhausted,
    batchTranslateToFarsi,
    translateToFarsi,
  };
}

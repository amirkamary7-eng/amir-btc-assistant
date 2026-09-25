// ═════════════════════════════════════════════════════════════════════════════
// News Shared Helpers — extracted from worker-proxy.js.
//
// Leaf module: zero external dependencies. Contains pure functions
// for RSS parsing, HTML cleaning, news scoring/dedup, Persian output
// validation, and sanitization. Used by both News Feed and News AI.
//
// Behavior-preserving extraction: no logic, state, or API changes.
// ═══════════════════════════════════════════════════════════════════════════

const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITY_MAP[entity] || entity);
}

export function cleanHtml(rawHtml) {
  if (!rawHtml) {
    return '';
  }

  const cleanText = decodeHtmlEntities(String(rawHtml).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return cleanText.length > 150 ? `${cleanText.slice(0, 150)}...` : cleanText;
}

export function parseRelativeTime(dateString) {
  try {
    const cleanDate = String(dateString || '').split(' +')[0].split(' GMT')[0].trim();
    const parsedTime = new Date(`${cleanDate} UTC`);
    if (Number.isNaN(parsedTime.getTime())) {
      return 'اخیراً';
    }

    const diffMs = Date.now() - parsedTime.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) {
      return 'همین الان';
    }

    if (minutes < 60) {
      return `${minutes} دقیقه پیش`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} ساعت پیش`;
    }

    return `${Math.floor(hours / 24)} روز پیش`;
  } catch {
    return 'اخیراً';
  }
}

export function extractFirstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  if (!match) {
    return '';
  }

  const capturedValue = match.slice(1).find((value) => typeof value === 'string' && value.trim() !== '');
  return capturedValue ? decodeHtmlEntities(capturedValue.trim()) : '';
}

export function extractImageUrl(descriptionHtml, itemBlock) {
  // 1. Check for <img src="..."> inside description HTML
  const imgMatch = String(descriptionHtml || '').match(/src="([^"]+)"/i);
  if (imgMatch) return imgMatch[1];

  // 2. Check for <enclosure url="..."> (used by IRNA, ISNA, many Persian feeds)
  if (itemBlock) {
    const enclosureMatch = String(itemBlock).match(/<enclosure[^>]+url="([^"]+)"/i);
    if (enclosureMatch) return enclosureMatch[1];
  }

  return 'https://images.cryptocompare.com/news/default/bitcoin.png';
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: PRE-FILTER ENGINE — Rule-based, 0 AI calls
// Filters out low-importance news before any translation or AI processing.
// Reduces ~48 raw RSS items to ~8-12 high-importance articles.
// ═══════════════════════════════════════════════════════════════════════════

const IMPORTANCE_KEYWORDS = [
  // Breaking (+3)
  { words: ['breaking', 'urgent', 'flash', 'just in', 'فوری', 'breaking:'], score: 3, tag: 'breaking' },
  // Bitcoin (+2)
  { words: ['bitcoin', 'btc', 'بیت‌کوین', 'بیت کوین'], score: 2, tag: 'bitcoin' },
  // Ethereum (+2)
  { words: ['ethereum', 'eth', 'اتریوم'], score: 2, tag: 'ethereum' },
  // ETF (+2)
  { words: ['etf', 'spot etf', 'bitcoin etf', 'ethereum etf'], score: 2, tag: 'etf' },
  // Federal Reserve / FOMC (+2)
  { words: ['fed', 'fomc', 'federal reserve', 'powell', 'rate cut', 'rate hike', 'interest rate', 'fed chair'], score: 2, tag: 'fed' },
  // SEC / Regulation (+2)
  { words: ['sec', 'securities and exchange', 'regulation', 'lawsuit', 'sanction', 'approve', 'ban', 'delist', 'delisting'], score: 2, tag: 'regulation' },
  // Hack / Security (+2)
  { words: ['hack', 'exploit', 'breach', 'stolen', 'vulnerability', 'security', 'scam', 'fraud', 'rug pull'], score: 2, tag: 'security' },
  // Exchange (+1)
  { words: ['binance', 'coinbase', 'kraken', 'okx', 'bybit', 'listing', 'listed', 'exchange', 'trading'], score: 1, tag: 'exchange' },
  // Institutional (+1)
  { words: ['microstrategy', 'tesla', 'blackrock', 'institutional', 'adoption', 'treasury', 'saylor'], score: 1, tag: 'institutional' },
  // Macro (+1)
  { words: ['cpi', 'ppi', 'nfp', 'gdp', 'inflation', 'unemployment', 'recession', 'consumer price', 'producer price'], score: 1, tag: 'macro' },
  // Partnership (+1)
  { words: ['partnership', 'integration', 'collaboration', 'merger', 'acquisition'], score: 1, tag: 'partnership' },
];

/**
 * Score a single RSS item by importance.
 * Returns { score, tags } or null if item has 0 importance matches.
 */
export function scoreNewsItem(item) {
  const title = String(item.title || '').toLowerCase();
  const description = String(item.description || '').toLowerCase();
  const text = `${title} ${description}`;

  // Reject items with title too short or too long (spam)
  const titleLen = String(item.title || '').trim().length;
  if (titleLen < 20 || titleLen > 200) return null;

  let score = 0;
  const tags = [];

  for (const group of IMPORTANCE_KEYWORDS) {
    for (const word of group.words) {
      if (text.includes(word)) {
        score += group.score;
        if (!tags.includes(group.tag)) tags.push(group.tag);
        break; // One match per group is enough
      }
    }
  }

  // No important keywords found — filter out
  if (score === 0) return null;

  // Bonus: freshness (published < 2 hours ago)
  if (item.pubDate) {
    try {
      const pubTs = new Date(item.pubDate).getTime();
      const ageHours = (Date.now() - pubTs) / (1000 * 60 * 60);
      if (ageHours < 2) score += 1;
      else if (ageHours < 6) score += 0.5;
    } catch {}
  }

  // Bonus: authoritative sources
  const sourceName = String(item._sourceName || '').toLowerCase();
  if (sourceName.includes('coindesk') || sourceName.includes('cointelegraph')) {
    score += 1;
  }

  return { score, tags, item };
}

/**
 * Fuzzy deduplication using Jaccard similarity on normalized titles.
 * Removes near-duplicate articles from different sources.
 */
export function fuzzyDedupNews(scoredItems, threshold = 0.7) {
  const normalized = scoredItems.map(s => ({
    ...s,
    normTitle: String(s.item.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 2),
  }));

  const result = [];
  const used = new Set();

  for (let i = 0; i < normalized.length; i++) {
    if (used.has(i)) continue;
    result.push(normalized[i]);
    used.add(i);

    for (let j = i + 1; j < normalized.length; j++) {
      if (used.has(j)) continue;
      // Jaccard similarity
      const setA = new Set(normalized[i].normTitle);
      const setB = new Set(normalized[j].normTitle);
      const intersection = [...setA].filter(w => setB.has(w)).length;
      const union = new Set([...setA, ...setB]).size;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity >= threshold) {
        used.add(j); // Mark as duplicate
      }
    }
  }

  return result;
}

/**
 * Pre-Filter Engine: filters, scores, dedupes, and selects top-N news items.
 * Called BEFORE any AI/translation processing.
 *
 * Input: array of { title, url, description, pubDate, image, _sourceName, _category }
 * Output: array of top-N scored items { score, tags, item }
 */
export function filterAndScoreNews(allItems, maxResults = 10) {
  // Stage 1: Score and filter (removes items with 0 importance)
  const scored = [];
  for (const item of allItems) {
    const result = scoreNewsItem(item);
    if (result) scored.push(result);
  }

  // Stage 2: Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Stage 3: Fuzzy dedup (remove near-duplicates)
  const deduped = fuzzyDedupNews(scored);

  // Stage 4: Top-N selection
  return deduped.slice(0, maxResults);
}

export function parseRssItems(rssText) {
  return [...String(rssText || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 6).map((match) => {
    const block = match[0];
    const title = extractFirstMatch(block, /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    // FIX: Link can also be wrapped in CDATA — handle both cases
    let link = extractFirstMatch(block, /<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>|<link>([\s\S]*?)<\/link>/i);
    // DEFENSIVE: strip any leftover CDATA markers if present
    if (link) {
      link = link.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    }
    const descriptionRaw = extractFirstMatch(
      block,
      /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i,
    );
    const pubDate = extractFirstMatch(block, /<pubDate>([\s\S]*?)<\/pubDate>/i);

    // PHASE 4 FIX: Parse <content:encoded> if available (RSS 2.0 with content module).
    // Not all feeds have this, but some provide full article text here — using it
    // eliminates the need for a separate article URL fetch (avoids publisher 429/403).
    // If content:encoded exists and is long enough, it will be used as the primary
    // article text in the extraction stage (before article HTML fetch).
    const contentEncodedRaw = extractFirstMatch(
      block,
      /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>|<content:encoded>([\s\S]*?)<\/content:encoded>/i,
    );

    return {
      title,
      url: link,
      descriptionHtml: descriptionRaw,
      description: cleanHtml(descriptionRaw),
      pubDate,
      image: extractImageUrl(descriptionRaw, block),
      contentEncoded: contentEncodedRaw || null,
    };
  }).map((item) => ({
    ...item,
    title: item.title || item.description,
  }));
}

/**
 * Translate text to Farsi using Cloudflare Workers AI (primary) with
 * Google Translate (unofficial endpoint) as fallback.
 *
 * Workers AI: free, no rate-limit, runs inside the Worker — no external call.
 * Google Translate fallback: kept for environments without AI binding.
 */

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 + P0-3: PERSIAN OUTPUT VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════
// Validates that AI-generated output is genuinely Persian (Farsi), not English,
// Chinese, or mixed-language garbage. Runs AFTER provider success but BEFORE
// storing to KV/DB. On failure: provider result is treated as invalid → fallback
// to next provider continues.
//
// Design principles:
//   1. Do NOT blindly reject English — proper nouns (Bitcoin, BTC, Ethereum, SEC,
//      ETF, NVIDIA, Binance) are legitimate in Persian text.
//   2. Do NOT blindly reject CJK — a company name (e.g., Alibaba/阿里巴巴) could
//      appear. But CJK ratio >5% is almost certainly contamination.
//   3. Use RATIO-based checks, not absolute presence.
//   4. Be conservative — better to accept a borderline Persian text than reject
//      a valid summary (false positive is worse than false negative for UX).
//
// Validation checks (ALL must pass for valid output):
//   1. Non-empty + minimum meaningful length (≥50 chars)
//   2. Persian character ratio ≥25% (Persian chars U+0600–U+06FF)
//   3. CJK character ratio ≤5% (CJK Unified Ideographs U+4E00–U+9FFF)
//   4. ASCII letter ratio ≤60% (allows proper nouns but rejects English-dominant text)
//   5. Not a provider error string (detect common error patterns)

// Whitelist of English proper nouns/tickers that are legitimate in Persian text.
// These are NOT counted as "English contamination" — they're expected.
const PERSIAN_ALLOWED_ENGLISH_TERMS = new Set([
  // Crypto names
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'cardano', 'ada',
  'dogecoin', 'doge', 'shiba', 'ripple', 'xrp', 'litecoin', 'ltc',
  'polygon', 'matic', 'avalanche', 'avax', 'chainlink', 'link',
  'polkadot', 'dot', 'uniswap', 'uni', 'aave', 'usdt', 'usdc',
  'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'gateio',
  'toncoin', 'ton', 'aptos', 'apt', 'arbitrum', 'arb', 'optimism', 'op',
  // Traditional finance
  'sec', 'etf', 'fed', 'fomc', 'nyse', 'nasdaq', 's&p', 'dow',
  'cpi', 'gdp', 'fomc', 'yellen', 'powell',
  // Tech companies
  'nvidia', 'amd', 'intel', 'microsoft', 'google', 'apple', 'meta',
  'tesla', 'amazon', 'openai', 'chatgpt',
  // Common financial terms used in Persian
  'api', 'ai', 'ml', 'defi', 'nft', 'ico', 'ieo', 'dao',
  'kyc', 'aml', 'p2p', 'cefi', 'dex',
  // News sources
  'reuters', 'bloomberg', 'coindesk', 'cointelegraph',
]);

/**
 * Validate that AI output is genuinely Persian (Farsi).
 *
 * @param {string} text - the AI-generated text to validate
 * @param {object} [opts] - optional configuration
 * @param {number} [opts.minLength=200] - minimum text length (P2-P2-2: was 50)
 * @param {number} [opts.maxLength=5000] - maximum text length (P2-P1-3)
 * @param {number} [opts.minPersianRatio=0.25] - minimum Persian char ratio (25%)
 * @param {number} [opts.maxCjkRatio=0.05] - DEPRECATED: CJK is now zero-tolerance
 * @param {number} [opts.maxAsciiLetterRatio=0.60] - DEPRECATED: replaced by segment-based check
 * @returns {{valid: boolean, reason: string, stats: object}}
 */

// ─── Crypto/Finance Abbreviation Whitelist ───────────────────────────
// These tokens are ALLOWED in Persian text without triggering English
// contamination. They are technical abbreviations commonly used in
// crypto/financial news and should not be transliterated.
//
// IMPORTANT: Only uppercase abbreviations (2-6 chars) are whitelisted.
// Common English words like "the", "market", "price" are NOT included.
const PERSIAN_WHITELIST_TOKENS = new Set([
  // ── Crypto symbols ──
  'BTC', 'ETH', 'USDT', 'USDC', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'BCH', 'XLM', 'ALGO', 'NEAR',
  'APT', 'ARB', 'OP', 'INJ', 'TIA', 'SEI', 'SUI', 'PEPE', 'WIF', 'BONK',
  'TAO', 'TRUMP', 'FET', 'RNDR', 'RENDER', 'STX', 'HBAR', 'VET', 'THETA',
  'SAND', 'MANA', 'AXS', 'GALA', 'CHZ', 'ENJ', 'FLOW', 'ICP', 'FIL', 'AR',
  'ETC', 'XMR', 'DASH', 'ZEC', 'NEO', 'IOTA', 'EOS', 'XTZ', 'RUNE', 'AAVE',
  'CRV', 'SUSHI', 'COMP', 'SNX', 'MKR', 'LDO', 'RPL', 'IMX', 'GRT', 'LRC',
  'KSM', 'GLMR', 'MOVR', 'ACALA', 'STRK', 'MANTA', 'PYTH', 'JTO', 'W',
  'WBTC', 'WETH', 'CBETH', 'STETH', 'RETH', 'USD', 'EUR', 'JPY', 'GBP',
  // ── Finance/economic abbreviations ──
  'ETF', 'GDP', 'CPI', 'PPI', 'FOMC', 'OPEC', 'SEC', 'FED', 'ECB', 'IMF',
  'WEF', 'KYC', 'AML', 'TVL', 'APR', 'APY', 'ROI', 'ICO', 'IEO', 'AMM',
  'LP', 'YTD', 'Q1', 'Q2', 'Q3', 'Q4', 'NFT', 'DAO', 'DEX', 'CEX', 'DEFI',
  'IPO', 'FDA', 'CFTC', 'FinCEN',
  // ── Tech abbreviations ──
  'API', 'AI', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JS', 'SDK', 'UI',
  'UX', 'OS', 'ID', 'IP', 'DNS', 'SSL', 'TLS', 'VPN', 'DAPP', 'SaaS',
  'P2P', 'B2B', 'B2C', 'RSS', 'JSON', 'XML', 'CSV',
]);

// Regex to match whitelisted tokens in text (case-sensitive, word-boundary)
const WHITELIST_REGEX = new Set([...PERSIAN_WHITELIST_TOKENS]);

/**
 * Check if a word is a whitelisted token.
 * Matches exact uppercase abbreviations (e.g., "BTC", "ETH").
 * Also matches common patterns like "BTC/USD", "100k BTC" — the word
 * boundary split will isolate "BTC" and "USD" separately.
 */
export function isWhitelistedToken(word) {
  // Strip non-alphanumeric chars from edges (punctuation)
  const cleaned = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  // Check exact match (case-sensitive — only uppercase abbreviations)
  if (WHITELIST_REGEX.has(cleaned)) return true;
  // PHASE 1 FIX: Restrict the ticker heuristic. Previously ANY 2-6 char
  // all-uppercase ASCII token was auto-whitelisted as a "ticker" — so
  // tokens like "XYZW", "TEST", "HELLO" would pass English contamination
  // checks. Now we only auto-allow tokens that look like real crypto/finance
  // tickers: 2-5 char all-uppercase with at least one consonant and no
  // common English-word patterns. This is intentionally conservative —
  // legitimate crypto tickers (BTC, ETH, SOL, XRP, etc.) are already in
  // PERSIAN_WHITELIST_TOKENS, so this heuristic only needs to catch new
  // tickers not yet in the whitelist. We require:
  //   - 2-5 chars (most crypto tickers are ≤ 5 chars)
  //   - all uppercase ASCII
  //   - NOT a common English word fragment (no vowels-only, no common suffixes)
  if (cleaned.length >= 2 && cleaned.length <= 5 && cleaned === cleaned.toUpperCase() && /^[A-Z]+$/.test(cleaned)) {
    // Reject vowel-only tokens (like "AE", "IO") — unlikely tickers
    if (/^[AEIOU]+$/.test(cleaned)) return false;
    // Reject tokens that look like common English words (3+ consecutive
    // consonants that form a word pattern are OK for tickers; the risk is
    // short English words like "THE", "AND", "FOR", "ARE", "BUT", "NOT",
    // "ALL", "CAN", "HAS", "HER", "HIM", "ITS", "MAY", "NEW", "NOW", "OLD",
    // "OUR", "SHE", "TEN", "TWO", "WAY", "WHO", "YES", "YET")
    const COMMON_ENGLISH_3 = new Set([
      'THE','AND','FOR','ARE','BUT','NOT','ALL','CAN','HAS','HER','HIM',
      'ITS','MAY','NEW','NOW','OLD','OUR','SHE','TEN','TWO','WAY','WHO',
      'YES','YET','OUT','HOW','WHY','GET','GOT','LET','RUN','TRY','USE',
      'BAD','BIG','BUY','CUT','DAY','END','FAR','FUN','GAS','HOT','ICE',
      'JOB','KEY','LAY','MAN','MAP','NOR','OFF','ONE','PAY','PUT','RAN',
      'SAW','SAY','SET','SIR','SIT','SKI','SON','SUM','TAKE','TAX','TOP',
      'TOW','TRY','VAN','WAR','WEB','WON','YOU','JOB','ANY','BAG','BAR',
      'BAT','BED','BIT','BOX','BUS','BUT','CAP','CAR','CAT','COW','DOG',
      'EAR','EAT','EGG','EYE','FAT','FEW','FIT','FIX','FLY','FOX','GAP',
      'GUN','GUY','HAT','HEN','HIP','HIT','HUN','HUT','INK','JAR','JAW',
      'JET','LEG','LIE','LIP','LOG','LOT','LOW','MAD','MAT','MIX','MOM',
      'MUD','NAP','NET','NIT','NOD','OAK','ODD','OIL','ORB','ORE','OWL',
      'PAD','PAL','PAN','PAT','PAW','PEN','PEA','PET','PIE','PIG','PIN',
      'PIT','POP','POT','PRO','PUP','RAG','RAM','RAN','RAP','RAT','RAW',
      'RAY','RED','RIB','RID','RIM','RIP','ROB','ROD','ROT','ROW','RUB',
      'RUG','RUM','SAD','SAG','SAT','SAW','SEA','SEE','SEW','SHE','SHY',
      'SIN','SIP','SIR','SIT','SIX','SKY','SLY','SOB','SOD','SON','SOP',
      'SOT','SOW','SOY','SPA','SPY','SUB','TAB','TAG','TAN','TAP','TAR',
      'TEA','TEN','THE','TIC','TIE','TIN','TIP','TOE','TON','TOO','TOP',
      'TOT','TOW','TOY','TRY','TUB','TWO','USE','VAN','VAT','VEX','VIA',
      'VOW','WAD','WAR','WAX','WAY','WEB','WED','WET','WHO','WHY','WIG',
      'WIN','WIT','WON','WOO','WOW','YAK','YAM','YAP','YAW','YEA','YES',
      'YET','YOU','ZAP','ZIP','ZOO',
    ]);
    if (cleaned.length === 3 && COMMON_ENGLISH_3.has(cleaned)) return false;
    // Not a common English word → treat as a plausible ticker. Allow it.
    return true;
  }
  return false;
}


export function validatePersianOutput(text, opts = {}) {
  const minLength = opts.minLength ?? 200; // P2-P2-2: was 50, now 200 (still 6x below 1200-char target)
  const maxLength = opts.maxLength ?? 5000; // P2-P1-3: max 5000 chars (well above 120-200 word target)
  const minPersianRatio = opts.minPersianRatio ?? 0.25;

  // 1. Empty/null check
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'empty_or_null', stats: {} };
  }

  const trimmed = text.trim();

  // 2. Minimum length check
  if (trimmed.length < minLength) {
    return { valid: false, reason: 'too_short', stats: { length: trimmed.length } };
  }

  // P2-P1-3: Maximum length check — reject excessively long output.
  if (trimmed.length > maxLength) {
    return { valid: false, reason: 'too_long', stats: { length: trimmed.length, maxLength } };
  }

  // 3. Provider error string detection
  const lowerTrimmed = trimmed.toLowerCase();
  const errorPatterns = [
    'error:', 'sorry, i cannot', 'i am unable to', 'rate limit',
    'quota exceeded', 'service unavailable', 'internal server error',
    '{"error"', '{"status": "error', 'http 4', 'http 5',
    'undefined', '[object object]', 'null',
  ];
  for (const pattern of errorPatterns) {
    if (lowerTrimmed.startsWith(pattern) || lowerTrimmed === pattern) {
      return { valid: false, reason: 'provider_error_string', stats: { pattern } };
    }
  }

  // 3b. PHASE 1 FIX — Persian refusal / meta-commentary / AI-error detection.
  // The old validator only matched English error prefixes via startsWith. AI
  // refusals in Persian ("متن ناقص است", "متن کامل را ارسال کنید", "به‌عنوان
  // یک مدل زبانی", "در این مقاله", "پاراگراف اول") slipped through entirely
  // because they pass length + Persian ratio + segment English checks.
  // We use case-insensitive substring match (not just startsWith) so these
  // patterns are caught anywhere in the response, not only at the start.
  // Patterns are normalized (trim + collapse whitespace) before matching.
  const normalizedTrimmed = lowerTrimmed.replace(/\s+/g, ' ');
  const refusalPatternsFa = [
    'متن ناقص', 'متن کامل را ارسال', 'متن کامل مقاله را ارسال',
    'لطفاً متن کامل', 'لطفا متن کامل', 'اطلاعات کافی نیست', 'اطلاعات ناکافی',
    'من نمی‌توانم تحلیل', 'من نمی توانم تحلیل', 'نمی‌توانم تحلیل', 'نمی توانم تحلیل',
    'به‌عنوان یک مدل', 'به عنوان یک مدل', 'به‌عنوان مدل', 'به عنوان مدل',
    'به‌عنوان یک هوش', 'به عنوان یک هوش', 'به‌عنوان هوش مصنوعی', 'به عنوان هوش مصنوعی',
    'در این مقاله', 'در این تحلیل', 'در این بخش', 'خلاصه خبر', 'تحلیل خبر',
    'تحلیل انجام‌شده', 'تحلیل انجام شده', 'پاراگراف اول', 'پاراگراف دوم',
    'پاراگراف سوم', 'پاراگراف چهارم', 'پاراگراف ۱', 'پاراگراف ۲',
    'پاراگراف ۳', 'پاراگراف ۴', 'پاراگراف بعدی', 'پاراگراف‌های بعدی',
    'منبع ناکافی', // sentinel emitted by the model when source is insufficient
    'متأسفم', 'متاسفم', 'عذرخواهی', 'cannot analyze', 'i cannot analyze',
    'i\'m sorry', 'i am sorry',
  ];
  for (const pattern of refusalPatternsFa) {
    if (normalizedTrimmed.includes(pattern)) {
      return { valid: false, reason: 'persian_refusal_or_meta', stats: { pattern } };
    }
  }
  // English refusal / meta-commentary patterns (case-insensitive substring)
  const refusalPatternsEn = [
    'as an ai language model', 'as a language model', 'as an ai model',
    'i cannot analyze', 'i can\'t analyze', 'cannot analyze this',
    'please provide the complete article', 'please provide the full article',
    'send full text', 'send the full text', 'send the complete article',
    'the article appears to be truncated', 'the article is truncated',
    'the text is incomplete', 'the provided text is incomplete',
    'the article is cut off', 'i need more context', 'i need more information',
    'i don\'t have enough information', 'i do not have enough information',
    'the source is insufficient', 'insufficient source', 'insufficient information',
    'here is your summary', 'here is the summary', 'here\'s the analysis',
    'sure, i can help', 'sure, here is', 'certainly, here',
  ];
  for (const pattern of refusalPatternsEn) {
    if (normalizedTrimmed.includes(pattern)) {
      return { valid: false, reason: 'english_refusal_or_meta', stats: { pattern } };
    }
  }

  // 4. Character analysis
  let persianChars = 0;
  let cjkChars = 0;
  let asciiLetters = 0;
  let totalChars = 0;
  let whitespace = 0;

  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    totalChars++;

    // Persian/Arabic range (U+0600–U+06FF) + Arabic Supplement (U+0750–U+077F)
    if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) {
      persianChars++;
    }
    // CJK Unified Ideographs (U+4E00–U+9FFF) + CJK Extension A (U+3400–U+4DBF)
    // + CJK Compatibility Ideographs (U+F900–U+FAFF) + CJK Radicals Supplement (U+2E80–U+2EFF)
    // + CJK Symbols and Punctuation (U+3000–U+303F) + Hiragana (U+3040–U+309F) + Katakana (U+30A0–U+30FF)
    else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
             (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x2E80 && code <= 0x2EFF) ||
             (code >= 0x3000 && code <= 0x303F) || (code >= 0x3040 && code <= 0x309F) ||
             (code >= 0x30A0 && code <= 0x30FF)) {
      cjkChars++;
    }
    // ASCII letters (a-z, A-Z)
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      asciiLetters++;
    }
    // Whitespace
    else if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) {
      whitespace++;
    }
  }

  const nonWhitespaceChars = totalChars - whitespace;
  if (nonWhitespaceChars === 0) {
    return { valid: false, reason: 'only_whitespace', stats: {} };
  }

  const persianRatio = persianChars / nonWhitespaceChars;
  const cjkRatio = cjkChars / nonWhitespaceChars;
  const asciiLetterRatio = asciiLetters / nonWhitespaceChars;

  const stats = {
    totalChars,
    nonWhitespaceChars,
    persianChars,
    cjkChars,
    asciiLetters,
    persianRatio: Number(persianRatio.toFixed(3)),
    cjkRatio: Number(cjkRatio.toFixed(3)),
    asciiLetterRatio: Number(asciiLetterRatio.toFixed(3)),
  };

  // 5. CJK ZERO-TOLERANCE check — even a single CJK character is contamination
  //    Previous: ratio > 5% → FAIL (allowed ~5 CJK chars per 100 non-whitespace)
  //    Now: ANY CJK character → FAIL (zero-tolerance)
  if (cjkChars > 0) {
    return { valid: false, reason: 'cjk_contamination', stats };
  }

  // 6. Persian ratio check (must be ≥25% Persian)
  if (persianRatio < minPersianRatio) {
    return { valid: false, reason: 'insufficient_persian', stats };
  }

  // 6b. PHASE 1 FIX (Arabic-only detection). The Persian/Arabic block
  // (U+0600–U+06FF) is shared between Arabic and Persian, so a pure-Arabic
  // response would pass the persianRatio check above (Arabic chars are counted
  // as Persian). This gate rejects text that uses the Arabic script range
  // but has NO Persian-specific letters.
  //
  // Persian-specific letters (NOT used in Arabic):
  //   پ (U+067E), چ (U+0686), ژ (U+0698), گ (U+06AF)
  //   Persian yeh ی (U+06CC) — Arabic uses ي (U+064A) instead
  //   Persian kaf ک (U+06A9) — Arabic uses ك (U+0643) instead
  //
  // We require at least ONE of these Persian-specific letters to be present
  // when the text contains Arabic-script chars. This catches pure-Arabic
  // responses (which would otherwise pass the persianRatio check) while
  // preserving all valid Persian text (which always contains at least one
  // of these letters in any real analysis).
  //
  // Edge case: an extremely short Persian text with only common letters
  // (no پ/چ/ژ/گ/ی/ک) could be falsely rejected. To avoid this, we only
  // apply the check when the text has a meaningful amount of Persian/Arabic
  // script (≥50 non-whitespace chars), AND we also accept Persian yeh/kaf
  // (U+06CC, U+06A9) which are very common in Persian but rare in Arabic.
  if (persianChars >= 50) {
    let hasPersianSpecificLetter = false;
    for (const ch of trimmed) {
      const code = ch.codePointAt(0);
      // Persian-specific: پ چ ژ گ (U+067E, U+0686, U+0698, U+06AF)
      // Persian yeh: ی (U+06CC) — Arabic uses ي (U+064A) instead
      // Persian kaf: ک (U+06A9) — Arabic uses ك (U+0643) instead
      if (code === 0x067E || code === 0x0686 || code === 0x0698 || code === 0x06AF ||
          code === 0x06CC || code === 0x06A9) {
        hasPersianSpecificLetter = true;
        break;
      }
    }
    if (!hasPersianSpecificLetter) {
      stats.arabicOnlyDetected = true;
      return { valid: false, reason: 'arabic_only', stats };
    }
  }

  // 7. Segment-based English contamination check
  //    Previous: overall ASCII letter ratio > 60% AND Persian < 40% → FAIL
  //    Now: split text into segments (by sentence/paragraph delimiters),
  //    remove whitelisted tokens, then check each segment for English
  //    contamination. If ANY segment has >40% English after whitelist
  //    removal, the entire text is rejected.
  //
  //    This catches scattered English words/phrases that were previously
  //    hidden by the overall ratio (e.g., a 800-char Persian text with
  //    a 50-char English sentence in the middle).
  const segments = trimmed.split(/[.!?؟。\n\r]+/).map(s => s.trim()).filter(s => s.length >= 10);

  for (const segment of segments) {
    // Remove whitelisted tokens from the segment before checking
    const words = segment.split(/\s+/);
    const nonWhitelistedWords = [];
    let segmentAsciiLetters = 0;
    let segmentNonWhitespace = 0;

    for (const word of words) {
      if (!isWhitelistedToken(word)) {
        nonWhitelistedWords.push(word);
        // Count ASCII letters in this non-whitelisted word
        for (const ch of word) {
          const code = ch.codePointAt(0);
          if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
            segmentAsciiLetters++;
          }
          if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
            segmentNonWhitespace++;
          }
        }
      }
    }

    if (segmentNonWhitespace > 0) {
      const segmentEnglishRatio = segmentAsciiLetters / segmentNonWhitespace;
      // If a segment has >40% English (after whitelist removal), reject
      if (segmentEnglishRatio > 0.40) {
        stats.contaminatedSegment = segment.slice(0, 80);
        stats.segmentEnglishRatio = Number(segmentEnglishRatio.toFixed(3));
        return { valid: false, reason: 'english_contamination_in_segment', stats };
      }
    }
  }

  // 8. Warning for borderline Persian ratio (25-45%) — does NOT reject
  if (persianRatio >= 0.25 && persianRatio < 0.45) {
    stats.warning = 'low_persian_ratio';
  }

  // 9. PHASE 1 FIX — Truncation detection.
  // A valid summary must end with a complete sentence (ending with ., !, ?, ؟,
  // or Persian full-stop U+06D4) OR end with a paragraph break (\n). If the
  // text ends mid-word/mid-sentence, it was likely cut by the max_tokens limit
  // and should not be published to users.
  // Exception: summaries < 250 chars may legitimately not end with a sentence
  // ender (e.g., a short phrase), so the check only applies to longer ones to
  // avoid false positives on short valid summaries.
  const trimmedEnd = trimmed.replace(/\s+$/, '');
  if (trimmedEnd.length >= 250) {
    const lastChar = trimmedEnd[trimmedEnd.length - 1];
    // Sentence enders: ASCII (. ! ?), Persian (؟ U+061F, ۔ U+06D4), newline.
    // We deliberately do NOT treat ',' or ';' (Persian ، ؛) as sentence enders
    // — they indicate the sentence continues and was cut.
    const isCompleteSentence = ['.', '!', '?', '؟', '\n', '۔'].includes(lastChar);
    if (!isCompleteSentence) {
      stats.lastChar = lastChar;
      stats.endsWithComplete = false;
      return { valid: false, reason: 'truncated_mid_sentence', stats };
    }
  }

  return { valid: true, reason: 'ok', stats };
}

// In-memory translation cache — avoids re-translating the same text across requests.
// Key: hash of input text, Value: translated text.
// Survives for the lifetime of the Worker isolate.
// P1-1 FIX: Added TTL (5 min) so bad translations don't persist for isolate lifetime.
// Previously: no TTL — a bad translation from m2m100 during a Groq outage was cached
// for the entire isolate lifetime (could be hours). Now: entries expire after 5 min,
// allowing the system to self-heal when providers recover.

export function sanitizeNewsTitle(rawTitle) {
  if (!rawTitle) return '';
  let title = String(rawTitle).replace(/\s+/g, ' ').trim();
  if (!title) return '';

  // 1. Remove consecutive duplicate words (2+ same words in a row → keep 1)
  //    Unicode-safe: doesn't rely on \b which fails for Persian/RTL text.
  let prev;
  do {
    prev = title;
    title = title.replace(/(\S+)(\s+\1)(?=\s|$)/gi, '$1');
  } while (title !== prev);

  // 2. Remove consecutive duplicate phrases (phrase of 2-8 words repeated)
  do {
    prev = title;
    title = title.replace(/((?:\S+\s+){1,8}\S+)\s+\1/gi, '$1');
  } while (title !== prev);

  // 3. Full title duplication: first half == second half
  const len = title.length;
  if (len > 20) {
    const mid = Math.floor(len / 2);
    const firstHalf = title.substring(0, mid).trim();
    const secondHalf = title.substring(mid).trim();
    if (firstHalf === secondHalf && firstHalf.length > 8) {
      title = firstHalf;
    } else {
      // Try finding the second occurrence of the first 10 chars
      const prefix = title.substring(0, 10);
      if (prefix.length === 10) {
        const secondOccurrence = title.indexOf(prefix, 5);
        if (secondOccurrence > 10 && secondOccurrence < len - 10) {
          const candidate = title.substring(0, secondOccurrence).trim();
          const remainder = title.substring(secondOccurrence).trim();
          if (candidate === remainder && candidate.length > 8) {
            title = candidate;
          }
        }
      }
    }
  }

  return title.replace(/\s+/g, ' ').trim();
}

/**
 * P2-P1-1: Sanitize AI summary before storage.
 * Applies the same duplicate-removal logic as sanitizeNewsTitle, plus:
 * - Strips HTML tags (prevents injection from AI output)
 * - Strips control characters
 * - Normalizes whitespace
 * Does NOT change valid Persian text — only removes artefacts.
 *
 * @param {string} rawSummary - the AI-generated summary
 * @returns {string} - sanitized summary
 */
export function sanitizeNewsSummary(rawSummary) {
  if (!rawSummary) return '';
  let summary = String(rawSummary);

  // 1. Strip HTML tags (AI models sometimes return <br>, <p>, etc.)
  summary = summary.replace(/<[^>]*>/g, '');

  // 2. Strip control characters (except \n which is valid paragraph separator)
  summary = summary.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 3. Decode common HTML entities that AI models sometimes return
  summary = summary
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // P3-P1-2 FIX: Preserve paragraph breaks (\n\n) before sanitizeNewsTitle
  // collapses all whitespace. sanitizeNewsTitle uses replace(/\s+/g, ' ')
  // which destroys \n — multi-paragraph summaries would become single block.
  // Solution: replace \n\n with a placeholder, run sanitizeNewsTitle, then
  // restore. Single \n (line break within paragraph) is converted to space
  // (correct — within a paragraph, single \n is just word wrapping).
  const PARAGRAPH_MARKER = '\x1F'; // Unit Separator — safe, never in AI output
  summary = summary.replace(/\n{2,}/g, PARAGRAPH_MARKER);
  summary = summary.replace(/\n/g, ' '); // single \n → space (within-paragraph wrap)

  // 4. Apply same duplicate-removal as sanitizeNewsTitle
  //    (reuses the proven logic for repeated words/phrases)
  summary = sanitizeNewsTitle(summary);

  // Restore paragraph breaks
  summary = summary.replace(new RegExp(PARAGRAPH_MARKER, 'g'), '\n\n');

  return summary;
}

export function classifySentiment(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const bullish = ['رشد', 'صعود', 'موفق', 'بهبود', 'رکورد', 'پامپ', 'بالا', 'bullish', ' ATH', 'رالی', ' approvals', 'ETF', 'adopt', 'فیض', 'profit', 'surge', 'jump', 'rally', 'gain', 'recovery', 'positive', 'approve'];
  const bearish = ['سقوط', 'نزول', 'هک', 'کلاهبردی', 'کاهش', 'ریزش', 'دانش', 'ban', 'bearish', 'hack', 'crash', 'drop', 'fall', 'decline', 'loss', 'scam', 'fraud', 'warning', 'risk', 'fear', 'sell-off', 'plunge', 'sanction', 'تحریم'];
  const breaking = ['فوری', 'breaking', 'urgent', 'breaking:', 'flash'];
  
  // Check breaking first
  if (breaking.some(w => text.includes(w))) return 'breaking';
  // Count matches
  const bullScore = bullish.filter(w => text.includes(w)).length;
  const bearScore = bearish.filter(w => text.includes(w)).length;
  if (bullScore > bearScore && bullScore > 0) return 'bullish';
  if (bearScore > bullScore && bearScore > 0) return 'bearish';
  // Check for macro keywords
  const macro = ['نرخ بهره', 'CPI', 'PPI', 'NFP', 'FOMC', 'تورم', 'inflation', 'interest rate', 'GDP', 'employment', 'unemployment'];
  if (macro.some(w => text.includes(w))) return 'macro';
  return 'neutral';
}


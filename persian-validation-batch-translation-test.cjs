/**
 * Persian Output Validation + Batch Translation Tests
 * =====================================================
 * Tests for:
 * 1. validatePersianOutput — CJK zero-tolerance, segment-based English, whitelist
 * 2. Batch translation (source-level)
 * 3. Persistence safety (source-level)
 *
 * Run: node --test persian-validation-batch-translation-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');

// ═════════════════════════════════════════════════════════════════════
// Standalone implementation for testing (mirrors worker-proxy.js logic)
// ═════════════════════════════════════════════════════════════════════

const PERSIAN_WHITELIST_TOKENS = new Set([
  'BTC', 'ETH', 'USDT', 'USDC', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'BCH', 'XLM', 'ALGO', 'NEAR',
  'APT', 'ARB', 'OP', 'INJ', 'TIA', 'SEI', 'SUI', 'PEPE', 'WIF', 'BONK',
  'TAO', 'TRUMP', 'FET', 'RNDR', 'RENDER', 'STX', 'HBAR', 'VET', 'THETA',
  'SAND', 'MANA', 'AXS', 'GALA', 'CHZ', 'ENJ', 'FLOW', 'ICP', 'FIL', 'AR',
  'ETC', 'XMR', 'DASH', 'ZEC', 'NEO', 'IOTA', 'EOS', 'XTZ', 'RUNE', 'AAVE',
  'CRV', 'SUSHI', 'COMP', 'SNX', 'MKR', 'LDO', 'RPL', 'IMX', 'GRT', 'LRC',
  'KSM', 'GLMR', 'MOVR', 'ACALA', 'STRK', 'MANTA', 'PYTH', 'JTO', 'W',
  'WBTC', 'WETH', 'CBETH', 'STETH', 'RETH', 'USD', 'EUR', 'JPY', 'GBP',
  'ETF', 'GDP', 'CPI', 'PPI', 'FOMC', 'OPEC', 'SEC', 'FED', 'ECB', 'IMF',
  'WEF', 'KYC', 'AML', 'TVL', 'APR', 'APY', 'ROI', 'ICO', 'IEO', 'AMM',
  'LP', 'YTD', 'Q1', 'Q2', 'Q3', 'Q4', 'NFT', 'DAO', 'DEX', 'CEX', 'DEFI',
  'IPO', 'FDA', 'CFTC', 'FinCEN',
  'API', 'AI', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JS', 'SDK', 'UI',
  'UX', 'OS', 'ID', 'IP', 'DNS', 'SSL', 'TLS', 'VPN', 'DAPP', 'SaaS',
  'P2P', 'B2B', 'B2C', 'RSS', 'JSON', 'XML', 'CSV',
]);

const WHITELIST_REGEX = new Set([...PERSIAN_WHITELIST_TOKENS]);

function isWhitelistedToken(word) {
  const cleaned = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  if (WHITELIST_REGEX.has(cleaned)) return true;
  if (cleaned.length >= 2 && cleaned.length <= 6 && cleaned === cleaned.toUpperCase() && /^[A-Z]+$/.test(cleaned)) {
    return true;
  }
  return false;
}

function validatePersianOutput(text, opts = {}) {
  const minLength = opts.minLength ?? 200;
  const maxLength = opts.maxLength ?? 5000;
  const minPersianRatio = opts.minPersianRatio ?? 0.25;

  if (!text || typeof text !== 'string') return { valid: false, reason: 'empty_or_null', stats: {} };
  const trimmed = text.trim();
  if (trimmed.length < minLength) return { valid: false, reason: 'too_short', stats: { length: trimmed.length } };
  if (trimmed.length > maxLength) return { valid: false, reason: 'too_long', stats: { length: trimmed.length, maxLength } };

  const lowerTrimmed = trimmed.toLowerCase();
  const errorPatterns = ['error:', 'sorry, i cannot', 'i am unable to', 'rate limit', 'quota exceeded', 'service unavailable', 'internal server error', '{"error"', '{"status": "error', 'http 4', 'http 5', 'undefined', '[object object]', 'null'];
  for (const pattern of errorPatterns) {
    if (lowerTrimmed.startsWith(pattern) || lowerTrimmed === pattern) return { valid: false, reason: 'provider_error_string', stats: { pattern } };
  }

  let persianChars = 0, cjkChars = 0, asciiLetters = 0, totalChars = 0, whitespace = 0;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    totalChars++;
    if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) persianChars++;
    else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x2E80 && code <= 0x2EFF) || (code >= 0x3000 && code <= 0x303F) || (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) cjkChars++;
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) asciiLetters++;
    else if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) whitespace++;
  }

  const nonWhitespaceChars = totalChars - whitespace;
  if (nonWhitespaceChars === 0) return { valid: false, reason: 'only_whitespace', stats: {} };

  const persianRatio = persianChars / nonWhitespaceChars;
  const cjkRatio = cjkChars / nonWhitespaceChars;
  const asciiLetterRatio = asciiLetters / nonWhitespaceChars;
  const stats = { totalChars, nonWhitespaceChars, persianChars, cjkChars, asciiLetters, persianRatio: Number(persianRatio.toFixed(3)), cjkRatio: Number(cjkRatio.toFixed(3)), asciiLetterRatio: Number(asciiLetterRatio.toFixed(3)) };

  // CJK ZERO-TOLERANCE
  if (cjkChars > 0) return { valid: false, reason: 'cjk_contamination', stats };

  // Persian ratio
  if (persianRatio < minPersianRatio) return { valid: false, reason: 'insufficient_persian', stats };

  // Segment-based English check
  const segments = trimmed.split(/[.!?؟。\n\r]+/).map(s => s.trim()).filter(s => s.length >= 10);
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    let segmentAsciiLetters = 0, segmentNonWhitespace = 0;
    for (const word of words) {
      if (!isWhitelistedToken(word)) {
        for (const ch of word) {
          const code = ch.codePointAt(0);
          if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) segmentAsciiLetters++;
          if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) segmentNonWhitespace++;
        }
      }
    }
    if (segmentNonWhitespace > 0) {
      const segmentEnglishRatio = segmentAsciiLetters / segmentNonWhitespace;
      if (segmentEnglishRatio > 0.40) {
        stats.contaminatedSegment = segment.slice(0, 80);
        stats.segmentEnglishRatio = Number(segmentEnglishRatio.toFixed(3));
        return { valid: false, reason: 'english_contamination_in_segment', stats };
      }
    }
  }

  if (persianRatio >= 0.25 && persianRatio < 0.45) stats.warning = 'low_persian_ratio';
  return { valid: true, reason: 'ok', stats };
}

// ═════════════════════════════════════════════════════════════════════
// Helper: generate valid Persian text (200+ chars)
// ═════════════════════════════════════════════════════════════════════
function makePersianText(extra = '') {
  const base = 'در دنیای ارزهای دیجیتال، بیت‌کوین به عنوان بزرگ‌ترین رمزارز بازار شناخته می‌شود. قیمت این ارز دیجیتال در ماه‌های اخیر نوسانات قابل‌توجهی را تجربه کرده است. تحلیل‌گران بازار معتقدند که روند آتی بیت‌کوین به عوامل متعددی بستگی دارد. عواملی مانند تصمیمات نهادهای نظارتی، وضعیت اقتصادی جهانی، و میزان پذیرش نهادی نقش مهمی در تعیین مسیر آینده این بازار ایفا می‌کنند. سرمایه‌گذاران باید با احتیاط عمل کنند و تحقیقات کامل انجام دهند. بازار کریپتو همواره با عدم قطعیت همراه بوده و نیاز به آگاهی کامل دارد.';
  return base + extra;
}

// ═════════════════════════════════════════════════════════════════════
// 1. CJK ZERO-TOLERANCE
// ═════════════════════════════════════════════════════════════════════

test('CJK-01: Pure Persian text → PASS', () => {
  const result = validatePersianOutput(makePersianText());
  assert.ok(result.valid, `Pure Persian should PASS, got: ${result.reason} ${JSON.stringify(result.stats)}`);
});

test('CJK-02: One Chinese character in the middle → FAIL', () => {
  const result = validatePersianOutput(makePersianText(' قیمت بیت‌کوین به سطح ت新 مهمی رسید. '));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('CJK-03: One Chinese character at the beginning → FAIL', () => {
  const result = validatePersianOutput('价' + makePersianText());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('CJK-04: One Chinese character at the end → FAIL', () => {
  const result = validatePersianOutput(makePersianText() + '价');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('CJK-05: A Chinese word → FAIL', () => {
  const result = validatePersianOutput(makePersianText(' قیمت در محدوده 比特币 مهمی قرار گرفت. '));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('CJK-06: Japanese Hiragana → FAIL', () => {
  const result = validatePersianOutput(makePersianText(' این یک آزمایش は مهم است. '));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('CJK-07: Japanese Katakana → FAIL', () => {
  const result = validatePersianOutput(makePersianText(' این یک آزمایش ア مهم است. '));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

// ═════════════════════════════════════════════════════════════════════
// 2. ENGLISH CONTAMINATION
// ═════════════════════════════════════════════════════════════════════

test('EN-01: Fully English text → FAIL', () => {
  const text = 'Bitcoin has experienced significant price movements in recent months. Analysts believe that the future trend of bitcoin depends on multiple factors including regulatory decisions and global economic conditions. Investors should proceed with caution and conduct thorough research before making any investment decisions in the cryptocurrency market.';
  const result = validatePersianOutput(text);
  assert.equal(result.valid, false);
});

test('EN-02: Persian with scattered English sentence → FAIL', () => {
  const text = makePersianText(' The market is showing strong bullish momentum today and the price is breaking out. ') + ' سرمایه‌گذاران باید با احتیاط عمل کنند.';
  const result = validatePersianOutput(text);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'english_contamination_in_segment');
});

test('EN-03: Persian with "the market price breaking" → FAIL', () => {
  const text = makePersianText(' the market price breaking news is very important for all traders. ');
  const result = validatePersianOutput(text);
  assert.equal(result.valid, false);
});

// ═════════════════════════════════════════════════════════════════════
// 3. WHITELIST
// ═════════════════════════════════════════════════════════════════════

test('WL-01: BTC → PASS', () => {
  const result = validatePersianOutput(makePersianText(' قیمت BTC به سطح مهمی رسید. '));
  assert.ok(result.valid, `BTC should be whitelisted, got: ${result.reason} ${JSON.stringify(result.stats)}`);
});

test('WL-02: ETH → PASS', () => {
  const result = validatePersianOutput(makePersianText(' قیمت ETH به سطح مهمی رسید. '));
  assert.ok(result.valid, `ETH should be whitelisted, got: ${result.reason}`);
});

test('WL-03: USDT → PASS', () => {
  const result = validatePersianOutput(makePersianText(' حجم معاملات USDT افزایش یافت. '));
  assert.ok(result.valid, `USDT should be whitelisted, got: ${result.reason}`);
});

test('WL-04: Multiple crypto symbols → PASS', () => {
  const result = validatePersianOutput(makePersianText(' در میان ارزهای مهم، BTC، ETH، SOL و BNB عملکرد خوبی داشتند. '));
  assert.ok(result.valid, `Multiple symbols should be whitelisted, got: ${result.reason}`);
});

test('WL-05: ETF → PASS', () => {
  const result = validatePersianOutput(makePersianText(' تصویب ETF بیت‌کوین تاثیر مهمی بر بازار داشت. '));
  assert.ok(result.valid, `ETF should be whitelisted, got: ${result.reason}`);
});

test('WL-06: Numbers → PASS', () => {
  const result = validatePersianOutput(makePersianText(' قیمت بیت‌کوین به 95000 دلار رسید و 3.5 درصد رشد داشت. '));
  assert.ok(result.valid, `Numbers should not trigger contamination, got: ${result.reason}`);
});

test('WL-07: Punctuation → PASS', () => {
  const result = validatePersianOutput(makePersianText(' به گفته تحلیل‌گران: «بازار در حال بهبود است!» این خبر مهم است. '));
  assert.ok(result.valid, `Punctuation should not trigger contamination, got: ${result.reason}`);
});

// ═════════════════════════════════════════════════════════════════════
// 4. EDGE CASES
// ═════════════════════════════════════════════════════════════════════

test('EDGE-01: Empty → FAIL', () => {
  assert.equal(validatePersianOutput('').valid, false);
});

test('EDGE-02: Null → FAIL', () => {
  assert.equal(validatePersianOutput(null).valid, false);
});

test('EDGE-03: Too short → FAIL', () => {
  assert.equal(validatePersianOutput('سلام', { minLength: 200 }).valid, false);
});

test('EDGE-04: Provider error → FAIL', () => {
  const result = validatePersianOutput('Error: rate limit exceeded. Please try again later. ' + makePersianText());
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'provider_error_string');
});

// ═════════════════════════════════════════════════════════════════════
// 5. SOURCE-LEVEL TESTS (verify worker-proxy.js has correct code)
// ═════════════════════════════════════════════════════════════════════

test('SRC-01: CJK zero-tolerance (cjkChars > 0)', () => {
  assert.match(WORKER_SRC, /cjkChars\s*>\s*0/);
});

test('SRC-02: Segment-based English check', () => {
  assert.match(WORKER_SRC, /english_contamination_in_segment/);
});

test('SRC-03: Whitelist has BTC', () => assert.match(WORKER_SRC, /'BTC'/));
test('SRC-04: Whitelist has ETH', () => assert.match(WORKER_SRC, /'ETH'/));
test('SRC-05: Whitelist has USDT', () => assert.match(WORKER_SRC, /'USDT'/));
test('SRC-06: JOURNALIST_SYSTEM prohibits CJK', () => assert.match(WORKER_SRC, /هیچ کاراکتر چینی/));
test('SRC-07: JOURNALIST_SYSTEM prohibits English', () => assert.match(WORKER_SRC, /هیچ کلمه یا عبارت انگلیسی مجاز نیست/));
test('SRC-08: JOURNALIST_SYSTEM has transliteration', () => {
  assert.match(WORKER_SRC, /بایننس/);
  assert.match(WORKER_SRC, /گوگل/);
});
test('SRC-09: batchTranslateToFarsi exists', () => assert.match(WORKER_SRC, /async function batchTranslateToFarsi/));
test('SRC-10: Batch uses JSON parsing + count check', () => assert.match(WORKER_SRC, /translations\.length === batchTexts\.length/));
test('SRC-11: Batch validates translations', () => assert.match(WORKER_SRC, /validatePersianOutput\(translated, \{[\s\S]*?minLength:\s*3/m));
test('SRC-12: Batch has fallback', () => assert.match(WORKER_SRC, /Falling back to individual translation/));
test('SRC-13: buildFarsiNewsArticles uses batch', () => assert.match(WORKER_SRC, /batchTranslateToFarsi\(titlesToTranslate/));
test('SRC-14: BATCH_TRANSLATION_MAX_BATCH defined', () => assert.match(WORKER_SRC, /BATCH_TRANSLATION_MAX_BATCH\s*=/));
test('SRC-15: Translation prompt prohibits CJK', () => assert.match(WORKER_SRC, /no Chinese\/Japanese\/Korean.*CJK/));

// ═════════════════════════════════════════════════════════════════════
// 6. PERSISTENCE SAFETY
// ═════════════════════════════════════════════════════════════════════

test('PERSIST-01: Validator runs BEFORE recordCircuitResult', () => {
  const section = WORKER_SRC.slice(WORKER_SRC.indexOf('async function attemptProvider'), WORKER_SRC.indexOf('async function attemptProvider') + 2000);
  const vIdx = section.indexOf('validator');
  const rIdx = section.indexOf('recordCircuitResult');
  assert.ok(vIdx > -1 && rIdx > -1 && vIdx < rIdx, 'Validator must run BEFORE recordCircuitResult');
});

test('PERSIST-02: saveAnalysis is inside succeedWithSummary (not before validation)', () => {
  // saveAnalysis must be INSIDE succeedWithSummary function, which is called
  // AFTER generateSummaryWithFallback returns a valid result.
  const succeedIdx = WORKER_SRC.indexOf('async function succeedWithSummary');
  const saveIdx = WORKER_SRC.indexOf('newsArticleRepo.saveAnalysis');
  assert.ok(succeedIdx > -1 && saveIdx > -1, 'Both must exist');
  assert.ok(saveIdx > succeedIdx, 'saveAnalysis must be inside succeedWithSummary');
  // Also verify generateSummaryWithFallback is called before succeedWithSummary call
  const generateCallIdx = WORKER_SRC.indexOf('generateSummaryWithFallback(env, JOURNALIST_USER_PROMPT');
  const succeedCallIdx = WORKER_SRC.indexOf('return succeedWithSummary(');
  assert.ok(generateCallIdx > -1 && succeedCallIdx > -1, 'Both calls must exist');
  assert.ok(generateCallIdx < succeedCallIdx, 'generateSummaryWithFallback must be called before succeedWithSummary');
});

test('PERSIST-03: succeedWithSummary call is after generateSummaryWithFallback call', () => {
  const generateCallIdx = WORKER_SRC.indexOf('generateSummaryWithFallback(env, JOURNALIST_USER_PROMPT');
  const succeedCallIdx = WORKER_SRC.indexOf('return succeedWithSummary(');
  assert.ok(generateCallIdx > -1 && succeedCallIdx > -1, 'Both calls must exist');
  assert.ok(generateCallIdx < succeedCallIdx, 'generateSummaryWithFallback must be called before succeedWithSummary');
});

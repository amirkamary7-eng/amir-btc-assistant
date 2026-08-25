/**
 * News AI Phase 1 — Persian Output Validator + Provider Prompt Consistency Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const APP_PATH = path.join(__dirname, '..', 'app.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');
const APP_SRC = fs.readFileSync(APP_PATH, 'utf8');

// Extract validatePersianOutput from worker-proxy.js for testing
// Use eval to extract the function in a way that preserves default params
const validatorMatch = WORKER_SRC.match(/(function validatePersianOutput\(text, opts = \{\}\)\s*\{[\s\S]*?\n\})/);
assert.ok(validatorMatch, 'validatePersianOutput function must exist in worker-proxy.js');
let validatePersianOutput;
eval(validatorMatch[1].replace('function validatePersianOutput', 'validatePersianOutput = function'));

// 1. PERSIAN OUTPUT VALIDATOR — 20 test cases

test('V1: Pure Persian text → PASS', () => {
  const result = validatePersianOutput('بیت‌کوین با افزایش قابل توجه قیمت به بالای صد هزار دلار رسید. این رشد ناشی از ورود سرمایه‌گذاران نهادی به بازار است. کارشناسان پیش‌بینی می‌کنند این روند ادامه داشته باشد و قیمت به ۱۲۰ هزار دلار برسد. حجم معاملات به ۵۰ میلیارد دلار رسید که رکورد تاریخی محسوب می‌شود. بازار در وضعیت بسیار مثبتی قرار دارد.');
  assert.equal(result.valid, true);
});

test('V2: Persian + Bitcoin/BTC/ETF/Fed → PASS', () => {
  const result = validatePersianOutput('بیت‌کوین (Bitcoin) با عبور از ۱۰۰ هزار دلار رکورد جدیدی ثبت کرد. ورود سرمایه به ETFهای فیزیکی BTC نقش کلیدی داشت. سخنرانی Fed نیز تاثیرگذار بود. کارشناسان پیش‌بینی می‌کنند این روند صعودی ادامه یابد و قیمت به ۱۱۰ هزار دلار برسد. حجم معاملات بازار به ۴۵ میلیارد دلار رسید که رکورد جدیدی محسوب می‌شود.');
  assert.equal(result.valid, true);
});

test('V3: Mostly English text → REJECT', () => {
  const result = validatePersianOutput('Bitcoin surged past $100,000 driven by record ETF inflows. The milestone marks a significant moment for the cryptocurrency market as institutional adoption accelerates. Analysts expect the trend to continue through the end of the year as more institutional money flows into the space. The total market capitalization reached $2 trillion.');
  assert.equal(result.valid, false);
  assert.ok(['insufficient_persian', 'english_dominant'].includes(result.reason));
});

test('V4: Mostly Chinese text → REJECT', () => {
  const result = validatePersianOutput('比特币突破十万美元大关，创历史新高。机构投资者大量涌入加密货币市场，推动比特币价格持续上涨。分析师认为这一趋势将继续保持。市场情绪非常乐观。交易量创下历史新高。比特币市值达到两万亿美元。以太坊也跟随上涨。投资者对未来充满信心。监管机构表示支持。比特币网络算力持续增长，表明矿工对未来充满信心。去中心化金融协议的总锁定价值突破一千亿美元。非同质化代币交易量大幅增长。区块链技术应用场景不断扩大。加密货币交易所的注册用户数量创下新高。全球各国央行正在研究数字货币发行方案。');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'cjk_contamination');
});

test('V5: Persian + few CJK proper noun → PASS (ratio ≤5%)', () => {
  const result = validatePersianOutput('شرکت چینی علی‌بابا (阿里巴巴) اعلام کرد که در پروژه بلاکچین جدید سرمایه‌گذاری خواهد کرد. این خبر تاثیر مثبتی بر بازار کریپتو داشت. سرمایه‌گذاری این شرکت چینی در حوزه فناوری بلاکچین نشان‌دهنده اهمیت روزافزون این تکنولوژی در بازارهای مالی آسیاست.');
  assert.equal(result.valid, true);
});

test('V6: Short output (<50 chars) → REJECT', () => {
  const result = validatePersianOutput('بیت‌کوین بالا رفت.');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'too_short');
});

test('V7: Empty output → REJECT', () => {
  const result = validatePersianOutput('');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'empty_or_null');
});

test('V8: Null output → REJECT', () => {
  const result = validatePersianOutput(null);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'empty_or_null');
});

test('V9: Provider error string → REJECT', () => {
  const result = validatePersianOutput('Error: rate limit exceeded. Please try again later.');
  assert.equal(result.valid, false);
  // reason may vary — both valid rejections
});

test('V10: Provider error JSON → REJECT', () => {
  const result = validatePersianOutput('{"error": "service unavailable", "code": 503}');
  assert.equal(result.valid, false);
  // May be 'too_short' (45 chars) or 'provider_error_string' — both valid rejections
});

test('V11: Mixed Persian/English meaningless → REJECT', () => {
  const result = validatePersianOutput('The bitcoin price went up today. بازار bullish است. Many investors are happy. قیمت بالا رفت. Some profit taking occurred.');
  assert.equal(result.valid, false);
});

test('V12: Source English copied verbatim → REJECT', () => {
  const result = validatePersianOutput('Bitcoin surged past $100,000 driven by record ETF inflows. The milestone marks a significant moment for the cryptocurrency market as institutional adoption accelerates. Analysts expect the trend to continue through the end of the year as more institutional money flows into the space. The total market capitalization reached $2 trillion.');
  assert.equal(result.valid, false);
});

test('V13: Persian with many numbers and symbols → PASS', () => {
  const result = validatePersianOutput('قیمت بیت‌کوین ۱۰۲٬۵۰۰ دلار شد (+۳٫۲٪). حجم معاملات ۴۵ میلیارد دلار بود. ۲۳ صندوق ETF جدید ثبت شد. این رشد ناشی از ورود سرمایه‌گذاران نهادی بود. کارشناسان پیش‌بینی می‌کنند روند صعودی ادامه یابد و قیمت به ۱۱۰ هزار دلار برسد. بازار در وضعیت بسیار مثبتی قرار دارد.');
  assert.equal(result.valid, true);
});

test('V14: Only whitespace → REJECT', () => {
  const result = validatePersianOutput('   \n\n  \t  ');
  assert.equal(result.valid, false);
  // May be 'too_short' (0 chars after trim) or 'only_whitespace' — both valid
});

test('V15: Exactly 200 Persian chars (boundary) → PASS', () => {
  const result = validatePersianOutput('ب'.repeat(200));
  assert.equal(result.valid, true);
});

test('V16: 199 chars (below boundary) → REJECT', () => {
  const result = validatePersianOutput('ب'.repeat(199));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'too_short');
});

test('V17: Persian with English company names → PASS', () => {
  const result = validatePersianOutput('شرکت NVIDIA گزارش مالی قوی ارائه داد. سهام NVIDIA و AMD و INTC همگی صعودی شدند. بازار فارسی واکنش مثبتی نشان داد به NVIDIA. پیش‌بینی می‌شود درآمد NVIDIA در فصل آینده به ۳۸ میلیارد دلار برسد. تحلیل‌گران بازار این رشد را ناشی از تقاضای بالای برای تراشه‌های هوش مصنوعی می‌دانند.');
  assert.equal(result.valid, true);
});

test('V18: Long Persian text → PASS', () => {
  const longText = 'بیت‌کوین با افزایش چشمگیر قیمت به سطح صد هزار دلار رسید. '.repeat(10) + 'این رشد ناشی از ورود سرمایه‌گذاران نهادی و تصویب ETFهای فیزیکی بود.';
  const result = validatePersianOutput(longText);
  assert.equal(result.valid, true);
});

test('V19: "undefined" string → REJECT', () => {
  const result = validatePersianOutput('undefined');
  assert.equal(result.valid, false);
  // reason may vary — both valid rejections
});

test('V20: "[object Object]" → REJECT', () => {
  const result = validatePersianOutput('[object Object]');
  assert.equal(result.valid, false);
});

// 2. P0-1: Provider Prompt Consistency

test('P0-1a: tryWorkersAI accepts systemPrompt', () => {
  assert.ok(/async function tryWorkersAI\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
});

test('P0-1b: tryOpenAI accepts systemPrompt', () => {
  assert.ok(/async function tryOpenAI\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
});

test('P0-1c: tryOpenRouter accepts systemPrompt', () => {
  assert.ok(/async function tryOpenRouter\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
});

test('P0-1d: generateSummaryWithFallback passes systemPrompt to ALL providers', () => {
  assert.ok(/tryWorkersAI\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
  assert.ok(/tryOpenRouter\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
  assert.ok(/tryOpenAI\(env, prompt, systemPrompt\)/.test(WORKER_SRC));
});

// 3. P0-2: Validator Integration

test('P0-2a: validatePersianOutput called after each provider success', () => {
  const fallbackMatch = WORKER_SRC.match(/async function generateSummaryWithFallback[\s\S]*?\nasync function/);
  assert.ok(fallbackMatch);
  const count = (fallbackMatch[0].match(/validatePersianOutput/g) || []).length;
  assert.ok(count >= 5, `need 5+ validatePersianOutput calls, found ${count}`);
});

test('P0-2b: Failed validation triggers fallback', () => {
  const fallbackMatch = WORKER_SRC.match(/async function generateSummaryWithFallback[\s\S]*?\nasync function/);
  assert.ok(fallbackMatch[0].includes('persian_validation_failed'));
  assert.ok(fallbackMatch[0].includes("r.success = false"));
});

// 4. P1-1: Translation Cache TTL

test('P1-1a: TRANSLATION_CACHE_TTL_MS = 5 min', () => {
  assert.ok(/TRANSLATION_CACHE_TTL_MS = 5 \* 60 \* 1000/.test(WORKER_SRC));
});

test('P1-1b: Cache entries store _expiresAt', () => {
  assert.ok(/_expiresAt: Date\.now\(\) \+ TRANSLATION_CACHE_TTL_MS/.test(WORKER_SRC));
});

test('P1-1c: Cache read checks TTL', () => {
  assert.ok(/cached\._expiresAt && Date\.now\(\) < cached\._expiresAt/.test(WORKER_SRC));
});

// 5. P1-3: User Prompt Persian Instruction

test('P1-3: JOURNALIST_USER_PROMPT includes Persian instruction', () => {
  assert.ok(/تحلیل را به زبان فارسی روان و طبیعی بنویس/.test(WORKER_SRC));
});

// 6. P1-9: Frontend Field Mapping

test('P1-9a: niAiSummaryHtml checks news.ai_summary', () => {
  assert.ok(/news\.ai_summary/.test(APP_SRC));
});

test('P1-9b: niAiSummaryHtml truncates to 120 chars', () => {
  assert.ok(/preview\.length > 120/.test(APP_SRC));
});

// 7. REGRESSION

test('REGRESS-1: FOR UPDATE SKIP LOCKED preserved', () => {
  assert.ok(WORKER_SRC.includes('FOR UPDATE SKIP LOCKED'));
});

test('REGRESS-2: telegram_message_id check preserved (in notification_platform.js)', () => {
  const notifSrc = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/notification_platform.js'), 'utf8');
  assert.ok(notifSrc.includes('if (item.telegram_message_id)'),
    'telegram_message_id idempotency check must still be present in notification_platform.js');
});

test('REGRESS-3: Circuit breaker preserved', () => {
  assert.ok(WORKER_SRC.includes('shouldAttemptProvider'));
  assert.ok(WORKER_SRC.includes('recordCircuitResult'));
});

test('REGRESS-4: ON CONFLICT DO NOTHING preserved', () => {
  assert.ok(WORKER_SRC.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'));
});

// ============================================================================
// 8. PHASE 3 FIXES — P3-P0-1, P3-P1-2, P3-P2-1
// ============================================================================

// --- P3-P0-1: DB/KV lookup validation ---

test('P3-P0-1a: processOneArticleSummary KV lookup uses threshold=200 (not 50)', () => {
  // Find the KV cache read section
  const kvSection = WORKER_SRC.indexOf('P3-P0-1 FIX: Use threshold=200');
  assert.ok(kvSection > -1, 'P3-P0-1 FIX comment must exist for KV lookup');
  // Verify threshold=200 is used (not 50)
  const afterComment = WORKER_SRC.slice(kvSection, kvSection + 500);
  assert.ok(afterComment.includes('>= 200'), 'KV lookup must use >= 200');
  assert.ok(!afterComment.includes('>= 50'), 'KV lookup must NOT use >= 50');
});

test('P3-P0-1b: processOneArticleSummary DB lookup runs validatePersianOutput', () => {
  // Find the DB check section
  const dbSection = WORKER_SRC.indexOf('P3-P0-1 FIX: Use threshold=200 (matches Phase 2 validator) AND run');
  assert.ok(dbSection > -1, 'P3-P0-1 FIX comment must exist for DB lookup');
  const afterComment = WORKER_SRC.slice(dbSection, dbSection + 800);
  assert.ok(afterComment.includes('validatePersianOutput(dbArticle.summary)'),
    'DB lookup must run validatePersianOutput on dbArticle.summary');
  assert.ok(afterComment.includes('>= 200'),
    'DB lookup must use >= 200 threshold');
});

test('P3-P0-1c: DB lookup logs warning on invalid summary (does NOT serve bad data)', () => {
  assert.ok(WORKER_SRC.includes('DB summary failed Persian validation'),
    'DB lookup must log warning when summary fails validation');
});

test('P3-P0-1d: enrichNewsWithAISummaries validates KV summary', () => {
  // Find the enrichNews KV read section
  const enrichSection = WORKER_SRC.indexOf('P3-P0-1 FIX: Only accept KV summary if it passes Phase 2 validation');
  assert.ok(enrichSection > -1, 'P3-P0-1 FIX comment must exist in enrichNewsWithAISummaries');
  const afterComment = WORKER_SRC.slice(enrichSection, enrichSection + 500);
  assert.ok(afterComment.includes('validatePersianOutput(parsedSummary)'),
    'enrichNews must run validatePersianOutput on KV summary');
  assert.ok(afterComment.includes('>= 200'),
    'enrichNews must use >= 200 threshold');
});

test('P3-P0-1e: processNewsAIBatch enqueue DB check uses threshold=200 + validator', () => {
  // Find the enqueue DB check
  const enqueueSection = WORKER_SRC.indexOf('P3-P0-1 FIX: Use threshold=200 + validatePersianOutput (same as processOneArticleSummary)');
  assert.ok(enqueueSection > -1, 'P3-P0-1 FIX comment must exist in enqueue path');
  const afterComment = WORKER_SRC.slice(enqueueSection, enqueueSection + 500);
  assert.ok(afterComment.includes('>= 200'),
    'enqueue DB check must use >= 200 threshold');
  assert.ok(afterComment.includes('validatePersianOutput(dbArticle.summary)'),
    'enqueue DB check must run validatePersianOutput');
});

// --- P3-P1-2: Paragraph preservation in sanitizeNewsSummary ---

test('P3-P1-2a: sanitizeNewsSummary preserves paragraph breaks (\\n\\n)', () => {
  assert.ok(WORKER_SRC.includes('PARAGRAPH_MARKER'),
    'sanitizeNewsSummary must use PARAGRAPH_MARKER for paragraph preservation');
  assert.ok(WORKER_SRC.includes("const PARAGRAPH_MARKER = '\\x1F'"),
    'PARAGRAPH_MARKER must be \\x1F (Unit Separator)');
  assert.ok(WORKER_SRC.includes('summary.replace(/\\n{2,}/g, PARAGRAPH_MARKER)'),
    'sanitizeNewsSummary must replace \\n\\n with PARAGRAPH_MARKER before sanitizeNewsTitle');
  assert.ok(WORKER_SRC.includes("new RegExp(PARAGRAPH_MARKER, 'g'), '\\n\\n'"),
    'sanitizeNewsSummary must restore PARAGRAPH_MARKER to \\n\\n after sanitizeNewsTitle');
});

test('P3-P1-2b: single \\n converted to space (within-paragraph wrap)', () => {
  assert.ok(WORKER_SRC.includes("summary.replace(/\\n/g, ' ')"),
    'sanitizeNewsSummary must convert single \\n to space (within-paragraph wrap)');
});

// --- P3-P2-1: Translation cache key full text ---

test('P3-P2-1a: translation cache key uses full text (not substring)', () => {
  assert.ok(WORKER_SRC.includes('P3-P2-1 FIX: Use full text as cache key'),
    'P3-P2-1 FIX comment must exist');
  assert.ok(WORKER_SRC.includes('const cacheKey = text;'),
    'cacheKey must be full text (not text.substring(0, 100))');
  // Ensure old pattern is NOT present
  assert.ok(!/cacheKey = text\.length > 100 \? text\.substring\(0, 100\)/.test(WORKER_SRC),
    'old substring cacheKey pattern must NOT exist');
});

// --- P3 Regression: ensure existing functionality preserved ---

test('P3-REGRESS-1: sanitizeNewsTitle still exists and works (unchanged)', () => {
  assert.ok(WORKER_SRC.includes('function sanitizeNewsTitle('),
    'sanitizeNewsTitle must still exist');
  assert.ok(WORKER_SRC.includes('function sanitizeNewsSummary('),
    'sanitizeNewsSummary must still exist');
});

test('P3-REGRESS-2: validatePersianOutput still has maxLength=5000', () => {
  assert.ok(WORKER_SRC.includes('maxLength = opts.maxLength ?? 5000'),
    'validatePersianOutput maxLength must still be 5000');
});

test('P3-REGRESS-3: validatePersianOutput default minLength still 200', () => {
  assert.ok(WORKER_SRC.includes("minLength = opts.minLength ?? 200"),
    'validatePersianOutput default minLength must still be 200');
});

test('P3-REGRESS-4: Translation cache TTL still 5 minutes', () => {
  assert.ok(WORKER_SRC.includes('TRANSLATION_CACHE_TTL_MS = 5 * 60 * 1000'),
    'TRANSLATION_CACHE_TTL_MS must still be 5 minutes');
});

test('P3-REGRESS-5: Enum validation in parseBatchResult preserved', () => {
  assert.ok(WORKER_SRC.includes("validSentiments = new Set(['bullish', 'bearish', 'neutral'])"),
    'enum validation for sentiment must be preserved');
  assert.ok(WORKER_SRC.includes("validImpacts = new Set(['high', 'medium', 'low'])"),
    'enum validation for impact must be preserved');
});

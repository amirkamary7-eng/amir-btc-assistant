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

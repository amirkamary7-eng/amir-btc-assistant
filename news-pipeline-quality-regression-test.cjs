/**
 * News Pipeline Quality Regression Tests
 *
 * Tests the Phase 1-7 fixes for the News Pipeline:
 *   - Article truncation at sentence boundary (not character)
 *   - JOURNALIST_SYSTEM prompt: no paragraph labels, anti-meta-commentary, sentinel
 *   - validatePersianOutput: Persian/English refusal detection, truncation detection
 *   - Source integrity: insufficient-length source rejected
 *   - DB: pub_date column + ORDER BY pub_date + saveAnalysis preserves enrichment
 *   - KV: published_at uses pub_date (not Date.now())
 *   - Cache hygiene: corrupt KV deleted on read rejection
 *   - Frontend: date+time display, hero Persian keywords + freshness, word-boundary truncation
 *
 * Uses source-eval pattern (same as membership-rules-test.cjs / bilingual tests).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const NEWS_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/news_articles.js'), 'utf8');
const APP_JS_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const MIGRATE_SRC = fs.readFileSync(path.join(__dirname, 'scripts/00-migrate.sql'), 'utf8');

// ─── A. Article truncation at sentence boundary ─────────────────────────────

test('A1: article text truncation uses sentence boundary (not character)', () => {
  // The old code was: if (articleText.length > 8000) articleText = articleText.substring(0, 8000);
  // The new code searches for a sentence boundary before cutting.
  assert.ok(/SENTENCE_END/.test(WORKER_SRC), 'sentence boundary detection present');
  assert.ok(/cutAt/.test(WORKER_SRC), 'cutAt variable used for boundary-aware cut');
  // Ensure the old hard-cut pattern is GONE
  assert.ok(!/articleText\.substring\(0, 8000\);[\s\n]*if \(articleText\.length < 50\)/.test(WORKER_SRC),
    'old hard-cut-at-8000 pattern is removed');
});

test('A2: max_tokens increased from 1024 to 1536 for all 4 providers', () => {
  // Groq uses _groqRoutedFetch with maxTokens as a positional parameter.
  // Workers AI, OpenAI, OpenRouter use max_tokens: 1536 in the JSON body.
  const groqCount = (WORKER_SRC.match(/_groqRoutedFetch\(env,\s*[^)]*,\s*1536,\s*0\.4\)/g) || []).length;
  const otherCount = (WORKER_SRC.match(/max_tokens:\s*1536/g) || []).length;
  const total1536 = groqCount + otherCount;
  assert.ok(total1536 >= 4, `at least 4 max_tokens=1536 (Groq params: ${groqCount}, JSON body: ${otherCount}, total: ${total1536})`);
  // Ensure NO max_tokens: 1024 remains in the news provider chain
  assert.ok(!/max_tokens:\s*1024/.test(WORKER_SRC), 'no max_tokens: 1024 remains');
});

// ─── B. JOURNALIST_SYSTEM prompt quality ─────────────────────────────────────

test('B1: JOURNALIST_SYSTEM no longer requests "پاراگراف ۱/۲/۳/۴" structural labels', () => {
  // The old prompt had "پاراگراف ۱ — چه اتفاقی افتاد:" etc.
  // The new prompt should NOT have these as instructions (only in the forbidden list).
  const journalistStart = WORKER_SRC.indexOf("const JOURNALIST_SYSTEM = '");
  assert.ok(journalistStart > -1, 'JOURNALIST_SYSTEM found');
  const journalistEnd = WORKER_SRC.indexOf("';", journalistStart + 10);
  const prompt = WORKER_SRC.substring(journalistStart, journalistEnd);
  // Must NOT contain the old structural labels as instructions
  assert.ok(!prompt.includes('پاراگراف ۱ —'), 'no "پاراگراف ۱ —" label');
  assert.ok(!prompt.includes('پاراگراف ۲ —'), 'no "پاراگراف ۲ —" label');
  assert.ok(!prompt.includes('پاراگراف ۳ —'), 'no "پاراگراف ۳ —" label');
  assert.ok(!prompt.includes('پاراگراف ۴ —'), 'no "پاراگراف ۴ —" label');
});

test('B2: JOURNALIST_SYSTEM explicitly forbids meta-commentary and paragraph labels', () => {
  const journalistStart = WORKER_SRC.indexOf("const JOURNALIST_SYSTEM = '");
  const journalistEnd = WORKER_SRC.indexOf("';", journalistStart + 10);
  const prompt = WORKER_SRC.substring(journalistStart, journalistEnd);
  // Must contain the forbidden phrases list
  assert.ok(prompt.includes('پاراگراف اول'), 'forbids "پاراگراف اول"');
  assert.ok(prompt.includes('پاراگراف دوم'), 'forbids "پاراگراف دوم"');
  assert.ok(prompt.includes('در این مقاله'), 'forbids "در این مقاله"');
  assert.ok(prompt.includes('به‌عنوان یک مدل'), 'forbids "به‌عنوان یک مدل"');
  assert.ok(prompt.includes('متن ناقص'), 'forbids "متن ناقص"');
  assert.ok(prompt.includes('as an AI language model'), 'forbids "as an AI language model"');
});

test('B3: JOURNALIST_SYSTEM includes the "منبع ناکافی" sentinel instruction', () => {
  const journalistStart = WORKER_SRC.indexOf("const JOURNALIST_SYSTEM = '");
  const journalistEnd = WORKER_SRC.indexOf("';", journalistStart + 10);
  const prompt = WORKER_SRC.substring(journalistStart, journalistEnd);
  assert.ok(prompt.includes('منبع ناکافی'), 'prompt mentions "منبع ناکافی" sentinel');
  // Must instruct the model to write ONLY that phrase when source is insufficient
  assert.ok(prompt.includes('فقط و فقط'), 'prompt says "only" write the sentinel');
});

test('B4: JOURNALIST_USER_PROMPT mentions truncation awareness', () => {
  const userPromptStart = WORKER_SRC.indexOf('const JOURNALIST_USER_PROMPT = `');
  assert.ok(userPromptStart > -1, 'JOURNALIST_USER_PROMPT found');
  const userPromptEnd = WORKER_SRC.indexOf('`;', userPromptStart + 10);
  const userPrompt = WORKER_SRC.substring(userPromptStart, userPromptEnd);
  assert.ok(userPrompt.includes('ممکن است در انتها قطع شده باشد'), 'tells model article may be truncated');
  assert.ok(userPrompt.includes('منبع ناکافی'), 'user prompt mentions sentinel');
});

// ─── C. validatePersianOutput extensions ────────────────────────────────────

test('C1: validatePersianOutput has Persian refusal patterns', () => {
  assert.ok(/refusalPatternsFa/.test(WORKER_SRC), 'refusalPatternsFa array exists');
  const faPatternsStart = WORKER_SRC.indexOf('const refusalPatternsFa = [');
  const faPatternsEnd = WORKER_SRC.indexOf('];', faPatternsStart + 10);
  const faPatterns = WORKER_SRC.substring(faPatternsStart, faPatternsEnd);
  assert.ok(faPatterns.includes('متن ناقص'), 'detects "متن ناقص"');
  assert.ok(faPatterns.includes('متن کامل را ارسال'), 'detects "متن کامل را ارسال"');
  assert.ok(faPatterns.includes('اطلاعات کافی نیست'), 'detects "اطلاعات کافی نیست"');
  assert.ok(faPatterns.includes('به‌عنوان یک مدل'), 'detects "به‌عنوان یک مدل"');
  assert.ok(faPatterns.includes('در این مقاله'), 'detects "در این مقاله"');
  assert.ok(faPatterns.includes('پاراگراف اول'), 'detects "پاراگراف اول"');
  assert.ok(faPatterns.includes('منبع ناکافی'), 'detects "منبع ناکافی" sentinel');
});

test('C2: validatePersianOutput has English refusal patterns', () => {
  assert.ok(/refusalPatternsEn/.test(WORKER_SRC), 'refusalPatternsEn array exists');
  const enPatternsStart = WORKER_SRC.indexOf('const refusalPatternsEn = [');
  const enPatternsEnd = WORKER_SRC.indexOf('];', enPatternsStart + 10);
  const enPatterns = WORKER_SRC.substring(enPatternsStart, enPatternsEnd);
  assert.ok(enPatterns.includes('as an ai language model'), 'detects "as an AI language model"');
  assert.ok(enPatterns.includes('please provide the complete article'), 'detects "please provide the complete article"');
  assert.ok(enPatterns.includes('i cannot analyze'), 'detects "I cannot analyze"');
  assert.ok(enPatterns.includes('insufficient source'), 'detects "insufficient source"');
});

test('C3: refusal patterns use substring (includes), not just startsWith', () => {
  // The old errorPatterns used startsWith; the new refusal patterns must use includes
  // so they catch refusals in the middle of the response.
  const faBlock = WORKER_SRC.indexOf('for (const pattern of refusalPatternsFa)');
  assert.ok(faBlock > -1, 'refusalPatternsFa loop found');
  const loopBlock = WORKER_SRC.substring(faBlock, faBlock + 200);
  assert.ok(loopBlock.includes('.includes(pattern)'), 'uses .includes(pattern) not startsWith');
});

test('C4: validatePersianOutput has truncation detection', () => {
  assert.ok(/truncated_mid_sentence/.test(WORKER_SRC), 'truncated_mid_sentence reason exists');
  assert.ok(/endsWithComplete/.test(WORKER_SRC), 'endsWithComplete stat exists');
  // Must check the last character against sentence enders
  assert.ok(/isCompleteSentence/.test(WORKER_SRC), 'isCompleteSentence check exists');
});

test('C5: isWhitelistedToken restricts ticker heuristic (no common English words)', () => {
  // The new heuristic should have a COMMON_ENGLISH_3 blocklist
  assert.ok(/COMMON_ENGLISH_3/.test(WORKER_SRC), 'COMMON_ENGLISH_3 blocklist exists');
  // Should reject vowel-only tokens
  assert.ok(/\^\[AEIOU\]\+\$/.test(WORKER_SRC), 'rejects vowel-only tokens');
  // Should be 2-5 chars (not 2-6 as before)
  const heuristicBlock = WORKER_SRC.indexOf('cleaned.length >= 2 && cleaned.length <= 5');
  assert.ok(heuristicBlock > -1, 'ticker heuristic restricted to 2-5 chars');
});

// ─── C-fix. Arabic-only rejection (Issue 2 fix) ─────────────────────────────

test('C-FIX-1: validatePersianOutput has arabic_only rejection', () => {
  assert.ok(/arabic_only/.test(WORKER_SRC), 'arabic_only reason exists');
  assert.ok(/arabicOnlyDetected/.test(WORKER_SRC), 'arabicOnlyDetected stat exists');
  // Must check for Persian-specific letters
  assert.ok(WORKER_SRC.includes('0x067E'), 'checks Persian پ (U+067E)');
  assert.ok(WORKER_SRC.includes('0x0686'), 'checks Persian چ (U+0686)');
  assert.ok(WORKER_SRC.includes('0x0698'), 'checks Persian ژ (U+0698)');
  assert.ok(WORKER_SRC.includes('0x06AF'), 'checks Persian گ (U+06AF)');
  assert.ok(WORKER_SRC.includes('0x06CC'), 'checks Persian ی (U+06CC)');
  assert.ok(WORKER_SRC.includes('0x06A9'), 'checks Persian ک (U+06A9)');
});

test('C-FIX-2: Arabic-only text rejected, Persian accepted (functional test)', () => {
  // Extract validatePersianOutput for functional testing
  const start = WORKER_SRC.indexOf('const PERSIAN_WHITELIST_TOKENS = new Set([');
  const end = WORKER_SRC.indexOf('// In-memory translation cache');
  const block = WORKER_SRC.substring(start, end);
  const evaluator = new Function(block + '; return { validatePersianOutput };');
  const { validatePersianOutput } = evaluator();

  // Pure Arabic text — should be REJECTED as arabic_only
  const arabic = 'ارتفع البيتكوين اليوم بنسبة خمسة بالمائة. كما ارتفع الإيثيريوم أيضا. يعتقد المحللون أن هذا بسبب أخبار تنظيمية إيجابية. يأمل المستثمرون أن تستمر هذه الزيادة. هذه لحظة هامة لسوق العملات المشفرة. جميع المستثمرون يراقبون هذه التطورات بعناية. ارتفع البيتكوين اليوم بنسبة خمسة بالمائة. كما ارتفع الإيثيريوم أيضا. يعتقد المحللون أن هذا بسبب أخبار تنظيمية إيجابية. يأمل المستثمرون أن تستمر هذه الزيادة. هذه لحظة هامة لسوق العملات المشفرة. جميع المستثمرون يراقبون هذه التطورات بعناية.';
  const r1 = validatePersianOutput(arabic);
  assert.equal(r1.valid, false, 'pure Arabic text rejected');
  assert.equal(r1.reason, 'arabic_only', 'rejected as arabic_only');

  // Pure Persian text — should be ACCEPTED
  const persian = 'بیت‌کوین با افزایش قابل‌ توجهی به ۱۰۰ هزار دلار رسید. این افزایش ناشی از ورود سرمایه‌گذاران نهادی به بازار است و تحلیلگران معتقدند که این روند صعودی در هفته‌های آینده ادامه خواهد داشت. سرمایه‌گذاران خرد و کلان همگی منتظر تأیید این سطح قیمتی هستند. این یک نقطه عطف تاریقی برای بازار کریپتو محسوب می‌شود و می‌تواند تأثیر عمیقی بر سایر ارزها بگذارد.';
  const r2 = validatePersianOutput(persian);
  assert.equal(r2.valid, true, 'pure Persian text accepted');
  assert.equal(r2.reason, 'ok');

  // Persian with crypto tickers — should be ACCEPTED
  const persianTicker = 'بیت‌کوین (BTC) امروز با افزایش ۵ درصدی به ۱۰۵ هزار دلار رسید. اتریوم (ETH) نیز با رشد ۳ درصدی همراه بود. این رشد ناشی از اخبار مثبت درباره صندوق‌های ETF است. سرمایه‌گذاران امیدوارند که این روند ادامه داشته باشد. تحلیلگران معتقدند که BTC در هفته‌های آینده می‌تواند رکورد جدیدی ثبت کند و بازار صعودی خود را حفظ کند.';
  const r3 = validatePersianOutput(persianTicker);
  assert.equal(r3.valid, true, 'Persian with crypto tickers accepted');

  // Persian with proper nouns (Trump, Fed, SEC) — should be ACCEPTED
  const persianNames = 'ترامپ رئیس‌جمهور آمریکا امروز درباره سیاست‌های مالی جدید صحبت کرد. فدرال رزرو نیز اعلام کرد که نرخ بهره را بدون تغییر نگه می‌دارد. کمیسیون بورس و اوراق بهادار (SEC) در حال بررسی قانون‌گذاری جدید برای بازار کریپتو است. این تصمیمات می‌تواند تأثیر عمیقی روی بیت‌کوین و سایر ارزهای دیجیتال بگذارد. سرمایه‌گذاران باید مراقب این تحولات باشند و استراتژی مناسب اتخاذ کنند.';
  const r4 = validatePersianOutput(persianNames);
  assert.equal(r4.valid, true, 'Persian with proper nouns accepted');

  // Russian text — should still be REJECTED (insufficient_persian)
  const russian = 'Биткоин сегодня вырос на пять процентов. Эфириум также последовал этому тренду. Аналитики считают, что это связано с позитивными новостями о регулировании. Инвесторы надеются, что этот тренд сохранится. Это важный момент для рынка криптовалют. Все инвесторы внимательно следят за этими событиями. Биткоин сегодня вырос на пять процентов. Эфириум также последовал этому тренду. Аналитики считают, что это связано с позитивными новостями о регулировании. Инвесторы надеются, что этот тренд сохранится. Это важный момент для рынка криптовалют. Все инвесторы внимательно следят за этими событиями.';
  const r5 = validatePersianOutput(russian);
  assert.equal(r5.valid, false, 'Russian text rejected');
  assert.equal(r5.reason, 'insufficient_persian', 'rejected as insufficient_persian');

  // CJK text — should still be REJECTED (cjk_contamination)
  const cjk = '比特币今天上涨了百分之五。以太坊也随之上涨。分析师认为这是因为积极的监管消息。投资者希望这种趋势能继续下去。这是加密货币市场的一个重要时刻。所有投资者都在关注这些发展。比特币今天上涨了百分之五。以太坊也随之上涨。分析师认为这是因为积极的监管消息。投资者希望这种趋势能继续下去。这是加密货币市场的一个重要时刻。所有投资者都在关注这些发展。比特币今天上涨了百分之五。以太坊也随之上涨。分析师认为这是因为积极的监管消息。';
  const r6 = validatePersianOutput(cjk);
  assert.equal(r6.valid, false, 'CJK text rejected');
  assert.equal(r6.reason, 'cjk_contamination', 'rejected as cjk_contamination');
});

// ─── D. Source integrity ───────────────────────────────────────────────────

test('D1: source_insufficient_length rejection (50-200 chars → fail, no AI)', () => {
  assert.ok(/source_insufficient_length/.test(WORKER_SRC), 'source_insufficient_length reason exists');
  assert.ok(WORKER_SRC.includes("articleText.length < 200"), 'checks length < 200');
});

test('D2: source_insufficient_length in PERMANENT_FAIL_REASONS (no retry)', () => {
  assert.ok(
    /PERMANENT_FAIL_REASONS.*source_insufficient_length/.test(WORKER_SRC),
    'source_insufficient_length is permanent (no retry)'
  );
});

// ─── E. DB: pub_date column + ORDER BY + saveAnalysis ───────────────────────

test('E1: news_articles table has pub_date column in 00-migrate.sql', () => {
  assert.ok(/pub_date\s+TIMESTAMPTZ/.test(MIGRATE_SRC), 'pub_date TIMESTAMPTZ column in migration');
  assert.ok(/ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS pub_date/.test(MIGRATE_SRC),
    'idempotent ALTER TABLE for pub_date');
  assert.ok(/idx_news_articles_pub_date/.test(MIGRATE_SRC), 'pub_date index in migration');
});

test('E2: saveAnalysis persists pub_date', () => {
  assert.ok(NEWS_REPO_SRC.includes('pub_date'), 'saveAnalysis references pub_date');
  // The INSERT should include pub_date as a parameter
  assert.ok(/INSERT INTO news_articles.*pub_date/s.test(NEWS_REPO_SRC), 'INSERT includes pub_date');
  // ON CONFLICT should use COALESCE to preserve existing pub_date
  assert.ok(/COALESCE\(EXCLUDED\.pub_date, news_articles\.pub_date\)/.test(NEWS_REPO_SRC),
    'ON CONFLICT preserves pub_date with COALESCE');
});

test('E3: saveAnalysis updates sentiment/impact/impact_reason/coins on conflict', () => {
  // The ON CONFLICT DO UPDATE should now include sentiment, impact, impact_reason, coins
  const onConflictStart = NEWS_REPO_SRC.indexOf('ON CONFLICT (id) DO UPDATE SET');
  assert.ok(onConflictStart > -1, 'ON CONFLICT DO UPDATE SET found');
  const onConflictBlock = NEWS_REPO_SRC.substring(onConflictStart, onConflictStart + 500);
  assert.ok(onConflictBlock.includes('sentiment = EXCLUDED.sentiment'), 'updates sentiment');
  assert.ok(onConflictBlock.includes('impact = EXCLUDED.impact'), 'updates impact');
  assert.ok(onConflictBlock.includes('impact_reason = EXCLUDED.impact_reason'), 'updates impact_reason');
  assert.ok(onConflictBlock.includes('coins = EXCLUDED.coins'), 'updates coins');
});

test('E4: listForFeed orders by pub_date DESC first', () => {
  assert.ok(
    /ORDER BY pub_date DESC NULLS LAST/.test(NEWS_REPO_SRC),
    'listForFeed orders by pub_date DESC NULLS LAST'
  );
});

test('E5: listForFeed returns real pub_date from DB', () => {
  assert.ok(
    /pub_date:\s*realPubDate\s*\?/.test(NEWS_REPO_SRC),
    'listForFeed returns real pub_date from DB column'
  );
});

// ─── F. saveAnalysis call site passes real enrichment ──────────────────────

test('F1: saveAnalysis call site passes real sentiment/impact/coins (not hardcoded)', () => {
  // The old code hardcoded: sentiment: 'neutral', impact: 'low', impact_reason: '', coins: []
  // The new code should pass article.sentiment, article.impact, etc.
  const callStart = WORKER_SRC.indexOf('await newsArticleRepo.saveAnalysis(env, {');
  assert.ok(callStart > -1, 'saveAnalysis call site found');
  const callBlock = WORKER_SRC.substring(callStart, callStart + 800);
  assert.ok(callBlock.includes('article.sentiment'), 'passes article.sentiment (not hardcoded)');
  assert.ok(callBlock.includes('article.impact'), 'passes article.impact (not hardcoded)');
  assert.ok(callBlock.includes('article.impact_reason'), 'passes article.impact_reason');
  assert.ok(callBlock.includes('article.coins'), 'passes article.coins');
  assert.ok(callBlock.includes('article.pub_date'), 'passes article.pub_date');
  // Ensure the old hardcoded pattern is GONE
  assert.ok(!callBlock.includes("sentiment: 'neutral',  // Will be enriched"),
    'old hardcoded sentiment comment is removed');
});

// ─── G. KV published_at uses pub_date ────────────────────────────────────────

test('G1: publishArticleToFarsiNews uses pub_date for published_at (not Date.now())', () => {
  const fnStart = WORKER_SRC.indexOf('async function publishArticleToFarsiNews(');
  const fnBody = WORKER_SRC.substring(fnStart, fnStart + 2500);
  assert.ok(
    /publishedAt\s*=\s*article\.pub_date\s*\?/.test(fnBody),
    'publishedAt = article.pub_date ? ... : Date.now()'
  );
});

// ─── H. Cache hygiene — corrupt KV deleted on read ────────────────────────

test('H1: KV read path deletes corrupt entries on validation failure', () => {
  // The KV (JSON) and KV (plain) paths should both call env.APP_CACHE.delete on validation failure
  assert.ok(
    /APP_CACHE\?\.delete\?\.\(aiKey\)/.test(WORKER_SRC),
    'APP_CACHE.delete(aiKey) called on validation failure'
  );
  // Count occurrences — should be at least 3 (KV JSON, KV plain, enrichNews)
  const deleteCount = (WORKER_SRC.match(/APP_CACHE\?\.delete\?\.\(aiKey\)/g) || []).length;
  assert.ok(deleteCount >= 3, `at least 3 KV delete calls on validation failure (got ${deleteCount})`);
});

// ─── I. Frontend date/time ─────────────────────────────────────────────────

test('I1: formatNewsTimeTehran shows date + time (not just time)', () => {
  const fnStart = APP_JS_SRC.indexOf('function formatNewsTimeTehran(');
  assert.ok(fnStart > -1, 'formatNewsTimeTehran found');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  // Must include date formatting (day + month), not just hour + minute
  assert.ok(fnBody.includes("day: 'numeric'"), 'formats day');
  assert.ok(fnBody.includes("month:"), 'formats month');
  // Must include "today" detection
  assert.ok(fnBody.includes('isToday'), 'detects "today"');
  assert.ok(fnBody.includes('امروز'), 'has Persian "today" label');
  assert.ok(fnBody.includes('Today'), 'has English "today" label');
});

test('I2: formatNewsTimeTehran is locale-aware (FA vs EN)', () => {
  const fnStart = APP_JS_SRC.indexOf('function formatNewsTimeTehran(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes("currentLang"), 'checks currentLang');
  assert.ok(fnBody.includes("'en-US'"), 'uses en-US for English');
  assert.ok(fnBody.includes("'fa-IR'"), 'uses fa-IR for Persian');
});

// ─── J. Frontend Hero logic ────────────────────────────────────────────────

test('J1: niIsHeroEligible has Persian keyword equivalents', () => {
  const fnStart = APP_JS_SRC.indexOf('function niIsHeroEligible(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('بیت‌کوین'), 'has Persian "بیت‌کوین" keyword');
  assert.ok(fnBody.includes('اتریوم'), 'has Persian "اتریوم" keyword');
  assert.ok(fnBody.includes('فدرال'), 'has Persian "فدرال" keyword');
});

test('J2: niIsHeroEligible has freshness check (24h max)', () => {
  const fnStart = APP_JS_SRC.indexOf('function niIsHeroEligible(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('ageHours'), 'computes ageHours');
  assert.ok(fnBody.includes('> 24'), 'rejects articles older than 24 hours');
});

test('J3: niImpactLevel uses backend impact field', () => {
  const fnStart = APP_JS_SRC.indexOf('function niImpactLevel(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('backendImpact'), 'reads backend impact field');
  assert.ok(fnBody.includes("backendImpact === 'high'"), 'trusts backend high impact');
  assert.ok(fnBody.includes("backendImpact === 'medium'"), 'trusts backend medium impact');
  // Also has Persian keywords
  assert.ok(fnBody.includes('بیت‌کوین'), 'has Persian keyword for impact detection');
});

// ─── J-fix. Hero freshness gate runs FIRST (Issue 1 fix) ────────────────────

test('J-FIX-1: freshness check runs BEFORE breaking/high-impact/keyword paths', () => {
  // The freshness gate must be at the TOP of the function, before any
  // `return true` paths. We verify this by checking that the freshness
  // gate (ageHours > 24) appears BEFORE the `s === 'breaking'` check.
  const fnStart = APP_JS_SRC.indexOf('function niIsHeroEligible(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  const freshnessIdx = fnBody.indexOf('ageHours > 24');
  const breakingIdx = fnBody.indexOf("s === 'breaking'");
  assert.ok(freshnessIdx > -1, 'freshness check exists');
  assert.ok(breakingIdx > -1, 'breaking check exists');
  assert.ok(freshnessIdx < breakingIdx, 'freshness check runs BEFORE breaking check');
});

test('J-FIX-2: Hero eligibility scenarios (old important news rejected)', () => {
  // Extract niIsHeroEligible + niImpactLevel for functional testing
  const iStart = APP_JS_SRC.indexOf('function niImpactLevel(');
  const iEnd = APP_JS_SRC.indexOf('\n}', iStart + 10);
  const hStart = APP_JS_SRC.indexOf('function niIsHeroEligible(');
  const hEnd = APP_JS_SRC.indexOf('\n}', hStart + 10);
  const fnBlock = APP_JS_SRC.substring(iStart, iEnd + 2) + '\n' + APP_JS_SRC.substring(hStart, hEnd + 2);
  const fnEvaluator = new Function(fnBlock + '; return { niIsHeroEligible };');
  const { niIsHeroEligible } = fnEvaluator();

  // 30h + high impact → should be FALSE
  const news1 = { sentiment: 'bullish', impact: 'high', title: 'بیت‌کوین رکورد زد', pub_date: new Date(Date.now() - 30*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news1), false, '30h + high impact → false');

  // 25h + breaking → should be FALSE
  const news2 = { sentiment: 'breaking', impact: 'high', title: 'breaking', pub_date: new Date(Date.now() - 25*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news2), false, '25h + breaking → false');

  // 25h + major keyword → should be FALSE
  const news3 = { sentiment: 'neutral', impact: 'low', title: 'بیت‌کوین', pub_date: new Date(Date.now() - 25*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news3), false, '25h + keyword → false');

  // 23h + breaking → should be TRUE
  const news5 = { sentiment: 'breaking', impact: 'high', title: 'breaking', pub_date: new Date(Date.now() - 23*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news5), true, '23h + breaking → true');

  // 1h + high impact → should be TRUE
  const news6 = { sentiment: 'bullish', impact: 'high', title: 'بیت‌کوین رکورد زد', pub_date: new Date(Date.now() - 1*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news6), true, '1h + high impact → true');

  // old + no pub_date → preserved behavior (no freshness gate)
  const news7 = { sentiment: 'breaking', impact: 'high', title: 'breaking news' };
  assert.equal(niIsHeroEligible(news7), true, 'no pub_date + breaking → true (preserved)');

  // future timestamp → preserved (ageHours negative, < 24)
  const news8 = { sentiment: 'breaking', impact: 'high', title: 'breaking', pub_date: new Date(Date.now() + 2*60*60*1000).toISOString() };
  assert.equal(niIsHeroEligible(news8), true, 'future timestamp + breaking → true (preserved)');
});

// ─── K. Frontend field mapping ──────────────────────────────────────────────

test('K1: loadNews field mapping preserves impact, coins, impact_reason', () => {
  // The mapping should now include these fields (previously dropped)
  const mapStart = APP_JS_SRC.indexOf('articles = json.data.map(a => ({');
  assert.ok(mapStart > -1, 'field mapping found');
  const mapBlock = APP_JS_SRC.substring(mapStart, mapStart + 1500);
  assert.ok(mapBlock.includes('impact:'), 'preserves impact');
  assert.ok(mapBlock.includes('impact_reason:'), 'preserves impact_reason');
  assert.ok(mapBlock.includes('coins:'), 'preserves coins');
  assert.ok(mapBlock.includes('importance_score:'), 'preserves importance_score');
});

test('K2: hero slider click uses displayedNews.indexOf (not newsCache.indexOf)', () => {
  const heroStart = APP_JS_SRC.indexOf('function niRenderHeroSlider(');
  assert.ok(heroStart > -1, 'niRenderHeroSlider found');
  const heroEnd = APP_JS_SRC.indexOf('\n}', heroStart + 100);
  const heroBody = APP_JS_SRC.substring(heroStart, heroEnd);
  assert.ok(heroBody.includes('displayedNews.indexOf(n)'), 'uses displayedNews.indexOf');
  // The old newsCache.indexOf in the hero slider should be gone
  // (there may be other newsCache.indexOf in other functions, but not in hero)
  assert.ok(!/const idx = newsCache\.indexOf\(n\);[^]*openNewsModal/.test(heroBody),
    'no newsCache.indexOf in hero click handler');
});

test('K3: card preview truncation uses word boundary (not mid-word)', () => {
  const fnStart = APP_JS_SRC.indexOf('function niAiSummaryHtml(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes("preview[i] === ' '"), 'walks back to last space');
  assert.ok(fnBody.includes('trimEnd()'), 'trims trailing whitespace before adding ...');
});

test('K4: toggleSaveNews persists ai_summary and ai_status', () => {
  const fnStart = APP_JS_SRC.indexOf('function toggleSaveNews(');
  const fnEnd = APP_JS_SRC.indexOf('\n}', fnStart + 10);
  const fnBody = APP_JS_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('ai_summary:'), 'persists ai_summary');
  assert.ok(fnBody.includes('ai_status:'), 'persists ai_status');
  assert.ok(fnBody.includes('impact:'), 'persists impact');
  assert.ok(fnBody.includes('coins:'), 'persists coins');
});

// ─── L. Migration idempotency ───────────────────────────────────────────────

test('L1: news pub_date migration is idempotent (IF NOT EXISTS + ADD COLUMN IF NOT EXISTS)', () => {
  assert.ok(
    /ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS pub_date TIMESTAMPTZ/.test(MIGRATE_SRC),
    'idempotent ALTER TABLE for pub_date'
  );
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_news_articles_pub_date/.test(MIGRATE_SRC),
    'idempotent CREATE INDEX for pub_date'
  );
  // No DROP/TRUNCATE/DELETE for news in migration
  const newsSection = MIGRATE_SRC.substring(
    MIGRATE_SRC.indexOf('news_articles'),
    MIGRATE_SRC.indexOf('notification_broadcasts')
  );
  assert.ok(!/DROP |TRUNCATE|DELETE /i.test(newsSection), 'no destructive ops in news migration section');
});

// ─── M. Static safety checks (workflow guardrails) ──────────────────────────

test('M1: 00-migrate.sql passes workflow static safety checks', () => {
  // Replicate the checks from .github/workflows/deploy-production.yml lines 80-106
  if (grep(MIGRATE_SRC, 'DROP TABLE|DROP COLUMN|TRUNCATE|DROP TYPE|DROP SCHEMA', true)) {
    assert.fail('FORBIDDEN destructive DDL detected');
  }
  // All ADD COLUMN use IF NOT EXISTS
  const addColumnLines = MIGRATE_SRC.split('\n').filter(l => /ADD COLUMN/i.test(l) && !/^\s*--/.test(l));
  for (const line of addColumnLines) {
    if (!/IF NOT EXISTS/i.test(line)) {
      assert.fail(`ADD COLUMN without IF NOT EXISTS: ${line.trim()}`);
    }
  }
  // All CREATE INDEX use IF NOT EXISTS
  const createIndexLines = MIGRATE_SRC.split('\n').filter(l => /CREATE (UNIQUE )?INDEX/i.test(l) && !/^\s*--/.test(l));
  for (const line of createIndexLines) {
    if (!/IF NOT EXISTS/i.test(line)) {
      assert.fail(`CREATE INDEX without IF NOT EXISTS: ${line.trim()}`);
    }
  }
  // No CONCURRENTLY (in actual SQL, not comments)
  assert.ok(!grep(MIGRATE_SRC, 'CONCURRENTLY', true), 'no CONCURRENTLY in SQL');
});

// Helper: case-insensitive grep that ignores comment lines
function grep(src, pattern, stripComments) {
  const lines = src.split('\n');
  const re = new RegExp(pattern, 'i');
  for (const line of lines) {
    if (stripComments && /^\s*--/.test(line)) continue;
    if (re.test(line)) return true;
  }
  return false;
}

// ─── N. Bottom Navigation invariant preserved ──────────────────────────────

test('N1: bottom-nav CSS direction:rtl preserved', () => {
  const componentsCss = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
  assert.ok(/\.bottom-nav\s*\{[^}]*direction:\s*rtl/i.test(componentsCss),
    '.bottom-nav direction:rtl preserved');
});

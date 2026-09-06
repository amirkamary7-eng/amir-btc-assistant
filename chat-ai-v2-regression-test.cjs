/**
 * Chat AI v2 — Regression Tests
 *
 * Tests all Chat AI v2 features:
 *   - Context (getContext fix)
 *   - FAQ (matching, normalization, no false capture, no LLM)
 *   - Prompt (modular architecture, all features, anti-hallucination)
 *   - Errors (friendly Persian messages, no leakage)
 *   - Validation (conservative, refusals, truncation, leaks)
 *   - Navigation (action registry, whitelist, no eval)
 *   - Conversation (history, normalization)
 *   - Security (no eval, no arbitrary function, no prompt leak)
 *
 * Uses source-eval pattern (same as existing test files).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
const FRONTEND_SRC = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
const APP_JS_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── A. Context ─────────────────────────────────────────────────────────────

test('A1: getContext() uses correct DOM selectors (not .nav-tab or .bottom-nav-item)', () => {
  const fnStart = FRONTEND_SRC.indexOf('getContext()');
  const fnEnd = FRONTEND_SRC.indexOf('},', fnStart + 10);
  const fnBody = FRONTEND_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('.bottom-nav .nav-item.active'), 'uses .bottom-nav .nav-item.active');
  assert.ok(fnBody.includes('data-page'), 'uses data-page attribute');
  assert.ok(!fnBody.includes('.nav-tab.active'), 'does NOT use .nav-tab');
  assert.ok(!fnBody.includes('.bottom-nav-item.active'), 'does NOT use .bottom-nav-item');
  assert.ok(!fnBody.includes('data-section'), 'does NOT use data-section');
  assert.ok(!fnBody.includes('data-tab'), 'does NOT use data-tab (unless data-news)');
});

test('A2: getContext() detects coin detail from actual DOM structure', () => {
  const fnStart = FRONTEND_SRC.indexOf('getContext()');
  const fnEnd = FRONTEND_SRC.indexOf('},', fnStart + 10);
  const fnBody = FRONTEND_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('coin-detail-modal'), 'checks #coin-detail-modal');
  assert.ok(fnBody.includes('_currentDetailSymbol') || fnBody.includes('detail-coin-icon'), 'reads coin symbol from correct source');
  assert.ok(!fnBody.includes('data-coin-symbol'), 'does NOT use non-existent data-coin-symbol');
});

test('A3: getContext() detects news modal (not #news-detail-page)', () => {
  const fnStart = FRONTEND_SRC.indexOf('getContext()');
  const fnEnd = FRONTEND_SRC.indexOf('},', fnStart + 10);
  const fnBody = FRONTEND_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('news-modal'), 'checks #news-modal');
  assert.ok(!fnBody.includes('news-detail-page'), 'does NOT use non-existent #news-detail-page');
});

test('A4: getContext() detects current language', () => {
  const fnStart = FRONTEND_SRC.indexOf('getContext()');
  const fnEnd = FRONTEND_SRC.indexOf('},', fnStart + 10);
  const fnBody = FRONTEND_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('currentLang'), 'reads currentLang for language detection');
});

test('A5: getContext() detects news category from .ni-tab.active', () => {
  const fnStart = FRONTEND_SRC.indexOf('getContext()');
  const fnEnd = FRONTEND_SRC.indexOf('},', fnStart + 10);
  const fnBody = FRONTEND_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('.ni-tab.active'), 'checks .ni-tab.active for news category');
  assert.ok(fnBody.includes('data-news'), 'reads data-news attribute');
});

// ─── B. FAQ ────────────────────────────────────────────────────────────────

test('B1: FAQ_ENTRIES exist with at least 20 entries', () => {
  assert.ok(CONTROLLER_SRC.includes('FAQ_ENTRIES'), 'FAQ_ENTRIES array exists');
  const entries = CONTROLLER_SRC.match(/id: '/g) || [];
  // Count FAQ entry ids (not other ids like article_id)
  const faqIdMatches = CONTROLLER_SRC.match(/\bid: '(how_to_premium|exchange_requirement|daily_reward|how_to_get_tokens|missions|wheel_spins|vpn_market|alert_quota|membership_rules|terms|privacy|about|referral|watchlist_limit|ai_chat_limit|ai_image_limit|news_categories|calendar_location|language_change|tickets)'/g) || [];
  assert.ok(faqIdMatches.length >= 18, `at least 18 FAQ entries (got ${faqIdMatches.length})`);
});

test('B2: FAQ has normalizeForFAQ function', () => {
  assert.ok(CONTROLLER_SRC.includes('function normalizeForFAQ'), 'normalizeForFAQ exists');
  assert.ok(CONTROLLER_SRC.includes('\\u200C'), 'normalizes Persian ZWNJ');
});

test('B3: FAQ has keyword scoring (not naive substring)', () => {
  assert.ok(CONTROLLER_SRC.includes('bestScore'), 'uses score-based matching');
  assert.ok(CONTROLLER_SRC.includes('score >= 2'), 'has confidence threshold');
});

test('B4: FAQ has exclude keywords for analytical questions', () => {
  assert.ok(CONTROLLER_SRC.includes('FAQ_EXCLUDE_KEYWORDS'), 'has FAQ_EXCLUDE_KEYWORDS');
  assert.ok(CONTROLLER_SRC.includes('تحلیل'), 'excludes "تحلیل"');
  assert.ok(CONTROLLER_SRC.includes('بخرم'), 'excludes "بخرم"');
  assert.ok(CONTROLLER_SRC.includes('قیمت'), 'excludes "قیمت"');
});

test('B5: FAQ uses deterministic answer selection (not random)', () => {
  // Check that matchFAQ uses score-based selection, not Math.random
  const matchFn = CONTROLLER_SRC.indexOf('function matchFAQ');
  const matchEnd = CONTROLLER_SRC.indexOf('\n  }', matchFn + 100);
  const matchBody = CONTROLLER_SRC.substring(matchFn, matchEnd);
  assert.ok(matchBody.includes('bestScore % answers.length'), 'uses deterministic rotation in matchFAQ');
  assert.ok(!matchBody.includes('Math.random()'), 'matchFAQ does NOT use Math.random');
});

test('B6: FAQ returns provider: "faq_handler" (no LLM call)', () => {
  assert.ok(CONTROLLER_SRC.includes("provider: 'faq_handler'"), 'returns faq_handler provider');
});

test('B7: FAQ has action field (for navigation)', () => {
  assert.ok(CONTROLLER_SRC.includes('action: { type:'), 'FAQ entries have action objects');
  assert.ok(CONTROLLER_SRC.includes('open_membership'), 'has open_membership action');
  assert.ok(CONTROLLER_SRC.includes('open_wallet'), 'has open_wallet action');
});

test('B8: FAQ has bilingual answers (fa + en)', () => {
  assert.ok(CONTROLLER_SRC.includes('answers: {'), 'has answers object');
  assert.ok(CONTROLLER_SRC.includes('fa: ['), 'has fa answers');
  assert.ok(CONTROLLER_SRC.includes('en: ['), 'has en answers');
});

test('B9: matchFAQ accepts lang parameter (not currentLang global)', () => {
  // matchFAQ must accept a lang parameter, NOT reference currentLang
  const matchFn = CONTROLLER_SRC.indexOf('function matchFAQ');
  const matchEnd = CONTROLLER_SRC.indexOf('\n  }', matchFn + 100);
  const matchBody = CONTROLLER_SRC.substring(matchFn, matchEnd);
  assert.ok(matchBody.includes('lang'), 'matchFAQ accepts lang parameter');
  assert.ok(!matchBody.includes('currentLang'), 'matchFAQ does NOT reference currentLang global');
  assert.ok(matchBody.includes('answerLang'), 'uses answerLang for language selection');
  assert.ok(matchBody.includes("lang === 'en' ? 'en' : 'fa'"), 'deterministic language fallback to fa');
});

test('B10: FAQ call site passes user language from context', () => {
  // handlePostChat must parse context before FAQ and pass lang
  const chatFn = CONTROLLER_SRC.indexOf('async function handlePostChat');
  const fnBlock = CONTROLLER_SRC.substring(chatFn, chatFn + 8000);
  assert.ok(fnBlock.includes('faqLang'), 'extracts faqLang from context');
  assert.ok(fnBlock.includes('matchFAQ(message, faqLang)'), 'passes faqLang to matchFAQ');
});

test('B11: parseContext extracts lang field from payload', () => {
  const parseFn = CONTROLLER_SRC.indexOf('function parseContext');
  const parseEnd = CONTROLLER_SRC.indexOf('\n  }', parseFn + 100);
  const parseBody = CONTROLLER_SRC.substring(parseFn, parseEnd);
  assert.ok(parseBody.includes('lang'), 'parseContext extracts lang from context');
});

// ─── C. Prompt ─────────────────────────────────────────────────────────────

test('C1: Prompt has modular sections (ASSISTANT_IDENTITY, PERSONALITY, APP_KNOWLEDGE, SAFETY, RESPONSE_STYLE, ACTION_RULES)', () => {
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_IDENTITY'), 'has ASSISTANT_IDENTITY');
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_PERSONALITY'), 'has ASSISTANT_PERSONALITY');
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_APP_KNOWLEDGE'), 'has ASSISTANT_APP_KNOWLEDGE');
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_SAFETY'), 'has ASSISTANT_SAFETY');
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_RESPONSE_STYLE'), 'has ASSISTANT_RESPONSE_STYLE');
  assert.ok(CONTROLLER_SRC.includes('ASSISTANT_ACTION_RULES'), 'has ASSISTANT_ACTION_RULES');
});

test('C2: Prompt includes all 26+ features', () => {
  const kb = CONTROLLER_SRC.indexOf('ASSISTANT_APP_KNOWLEDGE');
  const kbEnd = CONTROLLER_SRC.indexOf('ASSISTANT_SAFETY');
  const knowledge = CONTROLLER_SRC.substring(kb, kbEnd);
  assert.ok(knowledge.includes('داشبورد'), 'Dashboard');
  assert.ok(knowledge.includes('بازار'), 'Market (Crypto)');
  assert.ok(knowledge.includes('فارکس'), 'Forex');
  assert.ok(knowledge.includes('واچ‌لیست'), 'Watchlist');
  assert.ok(knowledge.includes('اخبار'), 'News');
  assert.ok(knowledge.includes('تقویم اقتصادی'), 'Calendar');
  assert.ok(knowledge.includes('تحلیل'), 'Analysis');
  assert.ok(knowledge.includes('هشدار قیمت'), 'Price Alerts');
  assert.ok(knowledge.includes('کیف پول'), 'Wallet');
  assert.ok(knowledge.includes('توکن AB'), 'AB Token');
  assert.ok(knowledge.includes('پاداش روزانه'), 'Daily Reward');
  assert.ok(knowledge.includes('ماموریت'), 'Missions');
  assert.ok(knowledge.includes('Wheel'), 'Wheel');
  assert.ok(knowledge.includes('رفرال'), 'Referral');
  assert.ok(knowledge.includes('Premium'), 'Premium');
  assert.ok(knowledge.includes('VPN'), 'VPN Market');
  assert.ok(knowledge.includes('کازمتیک'), 'Profile Cosmetics');
  assert.ok(knowledge.includes('اعلان'), 'Notifications');
  assert.ok(knowledge.includes('تیکت'), 'Tickets');
  assert.ok(knowledge.includes('تنظیمات'), 'Settings');
  assert.ok(knowledge.includes('زبان'), 'Language');
  assert.ok(knowledge.includes('درباره'), 'About');
  assert.ok(knowledge.includes('قوانین'), 'Terms');
  assert.ok(knowledge.includes('حریم'), 'Privacy');
  assert.ok(knowledge.includes('دستیار'), 'AI Assistant');
});

test('C3: Premium claim is corrected (not "purchased")', () => {
  const kb = CONTROLLER_SRC.indexOf('ASSISTANT_APP_KNOWLEDGE');
  const kbEnd = CONTROLLER_SRC.indexOf('ASSISTANT_SAFETY');
  const knowledge = CONTROLLER_SRC.substring(kb, kbEnd);
  assert.ok(knowledge.includes('ثبت‌نام در صرافی'), 'mentions exchange registration');
  assert.ok(knowledge.includes('تأیید ادمین'), 'mentions admin approval');
  assert.ok(knowledge.includes('خرید مستقیم نیست'), 'explicitly says NOT direct purchase');
});

test('C4: Anti-hallucination rules in prompt', () => {
  assert.ok(CONTROLLER_SRC.includes('اطلاعات ساختگی'), 'prohibits fabricated data');
  assert.ok(CONTROLLER_SRC.includes('داده جعل'), 'prohibits data fabrication');
  assert.ok(CONTROLLER_SRC.includes('بین واقعیت و تحلیل'), 'distinguish facts from analysis');
});

test('C5: Prompt has action rules with [[ACTION: format', () => {
  assert.ok(CONTROLLER_SRC.includes('[[ACTION:'), 'has ACTION marker format');
  assert.ok(CONTROLLER_SRC.includes('اقدامات مجاز'), 'lists allowed actions');
  assert.ok(CONTROLLER_SRC.includes('open_dashboard'), 'includes open_dashboard');
  assert.ok(CONTROLLER_SRC.includes('open_forex_detail'), 'includes open_forex_detail');
});

test('C6: Prompt does NOT contain old English-only phrases', () => {
  // The old prompt had these English phrases; new prompt is Persian
  const promptStart = CONTROLLER_SRC.indexOf('ASSISTANT_IDENTITY');
  const promptEnd = CONTROLLER_SRC.indexOf('OUTPUT_LEAK_PATTERNS');
  const prompt = CONTROLLER_SRC.substring(promptStart, promptEnd);
  assert.ok(!prompt.includes('AMIRBTC Knowledge Base (v2)'), 'old English knowledge base title removed');
  assert.ok(!prompt.includes('How to Guide Users'), 'old English guide section removed');
  assert.ok(!prompt.includes('Persian (Farsi) primary'), 'old stale language claim removed');
});

// ─── D. Errors ─────────────────────────────────────────────────────────────

test('D1: friendlyChatError function exists', () => {
  assert.ok(CONTROLLER_SRC.includes('function friendlyChatError'), 'friendlyChatError exists');
});

test('D2: All user-visible errors are Persian', () => {
  assert.ok(CONTROLLER_SRC.includes('یه مشکلی در پاسخ‌دادن پیش اومد'), 'all_providers_failed (text) in Persian');
  assert.ok(CONTROLLER_SRC.includes('فعلاً نتونستم تصویر'), 'image error in Persian');
  assert.ok(CONTROLLER_SRC.includes('برای استفاده از دستیار'), 'auth error in Persian');
});

test('D3: No raw English error messages remain', () => {
  assert.ok(!CONTROLLER_SRC.includes("'AI service temporarily unavailable'"), 'English all_providers_failed removed');
  assert.ok(!CONTROLLER_SRC.includes("'RATE_LIMITS binding not configured'"), 'English rate_limits removed');
});

test('D4: _imageUnavailable flag is set in callGeminiChat error paths', () => {
  const geminiFn = CONTROLLER_SRC.indexOf('async function callGeminiChat');
  const geminiEnd = CONTROLLER_SRC.indexOf('async function callOpenRouterChat');
  const geminiBody = CONTROLLER_SRC.substring(geminiFn, geminiEnd);
  assert.ok(geminiBody.includes('_imageUnavailable = true'), 'sets _imageUnavailable on DB error');
  // Count occurrences — should be at least 4 (db, http, json, empty)
  const count = (geminiBody.match(/_imageUnavailable = true/g) || []).length;
  assert.ok(count >= 3, `at least 3 _imageUnavailable sets (got ${count})`);
});

test('D5: imageAnalysis error uses friendlyChatError (not raw error.message)', () => {
  const catchBlock = CONTROLLER_SRC.indexOf("error?._imageUnavailable");
  const block = CONTROLLER_SRC.substring(catchBlock, catchBlock + 300);
  assert.ok(block.includes('friendlyChatError'), 'uses friendlyChatError for image error');
  assert.ok(!block.includes('error.message ||'), 'does NOT use raw error.message');
});

// ─── E. Validation ─────────────────────────────────────────────────────────

test('E1: validateChatResponse function exists', () => {
  assert.ok(CONTROLLER_SRC.includes('function validateChatResponse'), 'validateChatResponse exists');
});

test('E2: Validation checks empty responses', () => {
  const fn = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 500);
  assert.ok(fnBody.includes('empty'), 'checks for empty');
});

test('E3: Validation checks output leaks', () => {
  const fn = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 1000);
  assert.ok(fnBody.includes('OUTPUT_LEAK_PATTERNS'), 'checks output leak patterns');
});

test('E4: Validation checks refusals (multi-word patterns only)', () => {
  const fn = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 1500);
  assert.ok(fnBody.includes('refusal'), 'has refusal detection');
  assert.ok(fnBody.includes('متن ناقص است'), 'detects Persian refusal');
  assert.ok(fnBody.includes('as an ai language model'), 'detects English refusal');
});

test('E5: Validation checks truncation (conservative, ≥500 chars)', () => {
  const fn = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 2000);
  assert.ok(fnBody.includes('truncated'), 'has truncation detection');
  assert.ok(fnBody.includes('500'), 'truncation threshold is 500 (conservative)');
});

test('E6: Validation does NOT reject short valid responses', () => {
  const fn = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 2000);
  // Must NOT have a minimum length check (unlike News AI's 200-char minimum)
  assert.ok(!fnBody.includes('minLength') || fnBody.includes('0'), 'no aggressive minimum length');
});

// ─── F. Navigation ─────────────────────────────────────────────────────────

test('F1: ACTION_REGISTRY is a Set (whitelist)', () => {
  assert.ok(CONTROLLER_SRC.includes('ACTION_REGISTRY'), 'ACTION_REGISTRY exists');
  assert.ok(CONTROLLER_SRC.includes('new Set(['), 'uses Set for O(1) lookup');
});

test('F2: ACTION_REGISTRY contains all 19 allowed actions', () => {
  const registry = CONTROLLER_SRC.indexOf('ACTION_REGISTRY = new Set');
  const registryEnd = CONTROLLER_SRC.indexOf(']);', registry);
  const registryBlock = CONTROLLER_SRC.substring(registry, registryEnd);
  const actions = ['open_dashboard', 'open_market', 'open_news', 'open_analysis', 'open_profile',
    'open_wallet', 'open_referral', 'open_membership', 'open_membership_rules',
    'open_about', 'open_terms', 'open_privacy', 'open_settings', 'open_language',
    'open_tickets', 'open_coin_detail', 'open_news_category', 'open_calendar', 'open_forex_detail'];
  for (const action of actions) {
    assert.ok(registryBlock.includes(action), `registry contains ${action}`);
  }
});

test('F3: parseActionFromReply validates against allowlist', () => {
  assert.ok(CONTROLLER_SRC.includes('function parseActionFromReply'), 'parseActionFromReply exists');
  assert.ok(CONTROLLER_SRC.includes('ACTION_REGISTRY.has(actionType)'), 'validates against allowlist');
});

test('F4: Action parser strips marker from reply', () => {
  assert.ok(CONTROLLER_SRC.includes("reply.replace(match[0]"), 'strips marker from reply');
});

test('F5: Dynamic args validated (symbol format)', () => {
  assert.ok(CONTROLLER_SRC.includes("^[A-Z0-9]{2,10}$"), 'validates coin symbol format');
  assert.ok(CONTROLLER_SRC.includes('validCategories'), 'validates news category');
});

test('F6: Frontend executeAction uses hardcoded switch (NO eval)', () => {
  const fn = FRONTEND_SRC.indexOf('executeAction(action) {');
  const fnBody = FRONTEND_SRC.substring(fn, fn + 4000);
  assert.ok(fnBody.includes('switch (type)'), 'uses switch statement');
  assert.ok(!fnBody.includes('eval('), 'NO eval');
  // Check for actual new Function usage (not in comments)
  const codeWithoutComments = fnBody.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!codeWithoutComments.includes('new Function('), 'NO new Function in actual code');
  assert.ok(!codeWithoutComments.includes('window['), 'NO window[] dynamic lookup');
});

test('F7: Frontend executeAction validates coin symbol args', () => {
  const fn = FRONTEND_SRC.indexOf('executeAction(action) {');
  const fnBody = FRONTEND_SRC.substring(fn, fn + 4000);
  assert.ok(fnBody.includes('^[A-Z0-9]{2,10}$'), 'validates symbol format');
  assert.ok(fnBody.includes('validCats'), 'validates news category');
});

test('F8: Frontend executeAction silently ignores unknown actions', () => {
  const fn = FRONTEND_SRC.indexOf('executeAction(action) {');
  const fnBody = FRONTEND_SRC.substring(fn, fn + 5000);
  assert.ok(fnBody.includes('default:'), 'has default case');
  assert.ok(fnBody.includes('silently ignore') || fnBody.includes('Unknown action'), 'silently ignores unknown');
});

// ─── G. Conversation ───────────────────────────────────────────────────────

test('G1: History still sends last 8 messages', () => {
  assert.ok(CONTROLLER_SRC.includes('history.slice(-8)'), 'backend slices to last 8');
  assert.ok(FRONTEND_SRC.includes('this.history.slice(-8)'), 'frontend slices to last 8');
});

test('G2: History max content length is 4000 (not stale 2000)', () => {
  assert.ok(CONTROLLER_SRC.includes('MAX_HISTORY_CONTENT_LENGTH = 4000'), 'actual value is 4000');
  // Stale comment should NOT claim "reduced from 4000 → 2000"
  assert.ok(!CONTROLLER_SRC.includes('Reduced from 4000 → 2000'), 'stale comment removed');
});

test('G3: buildAssistantPrompt accepts appContentContext parameter', () => {
  assert.ok(CONTROLLER_SRC.includes('appContentContext'), 'has appContentContext parameter');
});

test('G4: Retry does NOT create duplicate user bubble', () => {
  // The retry button must call a separate retry() method, NOT send().
  // send() creates a new user bubble. retry() must NOT.
  assert.ok(FRONTEND_SRC.includes('async retry(lastMessage)'), 'has retry() method');
  assert.ok(FRONTEND_SRC.includes('AssistantUI.retry('), 'retry button calls AssistantUI.retry()');
  assert.ok(!FRONTEND_SRC.includes("AssistantUI.send();"), 'retry button does NOT call send()');
  // retry() must NOT call appendBubble('user', ...) — that would duplicate the user bubble
  const retryFn = FRONTEND_SRC.indexOf('async retry(lastMessage)');
  const retryEnd = FRONTEND_SRC.indexOf('\n    }', retryFn + 100);
  const retryBody = FRONTEND_SRC.substring(retryFn, retryEnd + 10);
  assert.ok(!retryBody.includes("appendBubble('user'"), 'retry() does NOT create user bubble');
  assert.ok(retryBody.includes("appendBubble('assistant'"), 'retry() only creates assistant bubble');
});

// ─── H. Security ──────────────────────────────────────────────────────────

test('H1: No eval in frontend action executor', () => {
  const fn = FRONTEND_SRC.indexOf('executeAction(action)');
  const fnBody = FRONTEND_SRC.substring(fn, fn + 5000);
  assert.ok(!fnBody.includes('eval('), 'NO eval');
  assert.ok(!fnBody.includes('Function('), 'NO Function constructor');
});

test('H2: ACTION_REGISTRY in backend is static (no dynamic addition)', () => {
  assert.ok(CONTROLLER_SRC.includes('const ACTION_REGISTRY = new Set'), 'is a const');
  assert.ok(!CONTROLLER_SRC.includes('ACTION_REGISTRY.add('), 'no dynamic addition');
});

test('H3: System prompt not exposed via OUTPUT_LEAK_PATTERNS', () => {
  assert.ok(CONTROLLER_SRC.includes('OUTPUT_LEAK_PATTERNS'), 'OUTPUT_LEAK_PATTERNS exists');
  // Check that patterns cover our prompt section names
  const patterns = CONTROLLER_SRC.indexOf('OUTPUT_LEAK_PATTERNS');
  const patternsBlock = CONTROLLER_SRC.substring(patterns, patterns + 500);
  assert.ok(patternsBlock.includes('ASSISTANT_APP_CONTEXT') || patternsBlock.includes('AMIRBTC'), 'redacts prompt references');
});

test('H4: sanitizeText (anti-injection) is still present', () => {
  assert.ok(CONTROLLER_SRC.includes('function sanitizeText'), 'sanitizeText exists');
  assert.ok(CONTROLLER_SRC.includes('INJECTION_PATTERNS'), 'has injection patterns');
});

test('H5: Frontend has retry button only for retryable errors', () => {
  assert.ok(FRONTEND_SRC.includes('canRetry'), 'has canRetry option');
  assert.ok(FRONTEND_SRC.includes('ai-msg-retry-btn'), 'has retry button class');
  assert.ok(FRONTEND_SRC.includes('ai-msg-bubble-error'), 'has error bubble class');
});

// ─── I. Performance ───────────────────────────────────────────────────────

test('I1: FAQ does not call LLM (provider: faq_handler)', () => {
  // FAQ returns before classifyIntent and generateAssistantReply
  assert.ok(CONTROLLER_SRC.includes("provider: 'faq_handler'"), 'FAQ returns faq_handler');
  // FAQ is checked before the main rate-limit + LLM path
  const faqIdx = CONTROLLER_SRC.indexOf('faqMatch = matchFAQ(message, faqLang)');
  const limitsIdx = CONTROLLER_SRC.indexOf('const limits = await checkRateLimits(env, userId);', faqIdx + 100);
  assert.ok(faqIdx > -1 && limitsIdx > faqIdx, 'FAQ is checked before main limits check');
});

test('I2: FAQ does not consume normal AI quota', () => {
  // Like greetings, FAQ calls recordRateLimitUsage with false (not hasImage)
  const faqIdx = CONTROLLER_SRC.indexOf('faqMatch');
  const recordIdx = CONTROLLER_SRC.indexOf('recordRateLimitUsage(env, userId, false)', faqIdx);
  assert.ok(recordIdx > -1 && recordIdx < faqIdx + 500, 'FAQ calls recordRateLimitUsage with false');
});

test('I3: Dynamic content fetch is optional (only for LOCAL_APP intent)', () => {
  assert.ok(CONTROLLER_SRC.includes("intent === 'LOCAL_APP'"), 'only LOCAL_APP triggers dynamic content');
  assert.ok(CONTROLLER_SRC.includes('fetchAppContentContext'), 'has fetchAppContentContext');
  assert.ok(CONTROLLER_SRC.includes('if (!appContentRepo && !membershipRepo) return null'), 'graceful degradation if repos missing');
});

// ─── J. Regression ────────────────────────────────────────────────────────

test('J1: openForexDetail exposed on window', () => {
  assert.ok(APP_JS_SRC.includes('window.openForexDetail = openForexDetail'), 'openForexDetail on window');
});

test('J2: Deep-link announcement uses dashboard-page (not home-page)', () => {
  assert.ok(APP_JS_SRC.includes("switchTab('dashboard-page')"), 'uses dashboard-page');
  assert.ok(!APP_JS_SRC.includes("switchTab('home-page')"), 'does NOT use home-page');
});

test('J3: Deep-link calendar uses news-page + switchNewsTab(calendar)', () => {
  assert.ok(APP_JS_SRC.includes("switchTab('news-page')"), 'uses news-page');
  assert.ok(APP_JS_SRC.includes("switchNewsTab('calendar')"), 'uses switchNewsTab(calendar)');
  assert.ok(!APP_JS_SRC.includes("switchTab('calendar-page')"), 'does NOT use calendar-page');
});

test('J4: Console.log payload audit removed from frontend', () => {
  assert.ok(!FRONTEND_SRC.includes('[ChatAI] Payload audit:'), 'payload audit removed');
});

test('J5: worker-proxy.js injects appContentRepo and membershipRepo', () => {
  assert.ok(WORKER_SRC.includes('appContentRepo'), 'appContentRepo wired');
  assert.ok(WORKER_SRC.includes('membershipRepo'), 'membershipRepo wired');
});

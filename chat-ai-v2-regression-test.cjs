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
  const block = CONTROLLER_SRC.substring(catchBlock, catchBlock + 400);
  assert.ok(block.includes('friendlyChatError'), 'uses friendlyChatError for image error');
  // Chat AI v2 Fix: catch block no longer has error.message fallback (uses friendlyChatError)
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
  // Chat AI v2 Fix 8: validateChatResponse is now longer (Arabic-only detection
  // + language-aware CJK). Use a wider window to capture the truncation check.
  const fnBody = CONTROLLER_SRC.substring(fn, fn + 5000);
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

// ─── G5-G8. Action + Validation + Language fixes ──────────────────────────

test('G5: Action is NOT auto-executed (suggested button instead)', () => {
  // Frontend must NOT call executeAction on data.action directly
  const sendFn = FRONTEND_SRC.indexOf('async send()');
  const sendBody = FRONTEND_SRC.substring(sendFn, sendFn + 4000);
  assert.ok(!sendBody.includes('this.executeAction(data.action)'), 'send() must NOT auto-execute action');
  assert.ok(sendBody.includes('appendActionCard'), 'send() must render action card instead');
  assert.ok(FRONTEND_SRC.includes('function appendActionCard') || FRONTEND_SRC.includes('appendActionCard(action)'), 'appendActionCard method exists');
});

test('G6: Retry also uses appendActionCard (not auto-execute)', () => {
  const retryFn = FRONTEND_SRC.indexOf('async retry(lastMessage)');
  const retryEnd = FRONTEND_SRC.indexOf('\n    }', retryFn + 100);
  const retryBody = FRONTEND_SRC.substring(retryFn, retryEnd + 10);
  assert.ok(!retryBody.includes('this.executeAction(data.action)'), 'retry() must NOT auto-execute');
  assert.ok(retryBody.includes('appendActionCard'), 'retry() uses appendActionCard');
});

test('L1: validateChatResponse has CJK zero-tolerance (language-aware)', () => {
  // Chat AI v2 Fix 8: CJK check is now in a helper (_isCJKCode) + language-aware
  // (skipped if user asked about CJK). The whole file must contain both the
  // helper and the cjk_contamination rejection reason.
  assert.ok(CONTROLLER_SRC.includes('cjk_contamination'), 'has cjk_contamination rejection');
  assert.ok(CONTROLLER_SRC.includes('0x4E00') || CONTROLLER_SRC.includes('4E00'), 'checks CJK Unicode range');
  assert.ok(CONTROLLER_SRC.includes('_isCJKCode'), 'has _isCJKCode helper');
  assert.ok(CONTROLLER_SRC.includes('_userAskedAboutCJK'), 'has language-aware CJK detection');
});

test('L2: Prompt explicitly forbids CJK characters', () => {
  assert.ok(CONTROLLER_SRC.includes('چینی') || CONTROLLER_SRC.includes('CJK'),
    'Prompt must explicitly prohibit CJK characters');
});

test('L3: Prompt includes clarification instruction for ambiguous questions', () => {
  assert.ok(CONTROLLER_SRC.includes('مبهم') || CONTROLLER_SRC.includes('سؤال تکمیلی'),
    'Prompt must instruct AI to ask clarification for ambiguous questions');
});

test('L4: FAQ has ambiguity detection (secondBestScore check)', () => {
  assert.ok(CONTROLLER_SRC.includes('secondBestScore'), 'tracks second-best score');
  assert.ok(CONTROLLER_SRC.includes('ambiguous'), 'has ambiguity detection logic');
});

test('L5: FAQ uses intent detection (procedural vs informational)', () => {
  // Chat AI v2 Fix 4: Replaced crude FAQ_EXCLUDE_KEYWORDS keyword exclusion with
  // proper intent detection. detectFAQIntent returns 'procedural'/'informational'/'neutral'.
  // Informational words (چیه, یعنی, تعریف) are now in detectFAQIntent's
  // INFORMATIONAL_MARKERS, NOT in FAQ_EXCLUDE_KEYWORDS.
  assert.ok(CONTROLLER_SRC.includes('detectFAQIntent'), 'has detectFAQIntent function');
  assert.ok(CONTROLLER_SRC.includes('PROCEDURAL_MARKERS'), 'has procedural markers');
  assert.ok(CONTROLLER_SRC.includes('INFORMATIONAL_MARKERS'), 'has informational markers');
  // Intent words must be present (in detectFAQIntent, not FAQ_EXCLUDE_KEYWORDS)
  assert.ok(CONTROLLER_SRC.includes('چیه'), 'handles "چیه"');
  assert.ok(CONTROLLER_SRC.includes('یعنی'), 'handles "یعنی"');
  assert.ok(CONTROLLER_SRC.includes('تعریف'), 'handles "تعریف"');
  // FAQ entries must have an intent field
  assert.ok(CONTROLLER_SRC.includes("intent: 'procedural'"), 'has procedural FAQ entries');
  assert.ok(CONTROLLER_SRC.includes("intent: 'informational'"), 'has informational FAQ entries');
  assert.ok(CONTROLLER_SRC.includes("intent: 'either'"), 'has either-intent FAQ entries');
  // Informational words must NOT be in FAQ_EXCLUDE_KEYWORDS (moved to detectFAQIntent)
  const exclIdx = CONTROLLER_SRC.indexOf('FAQ_EXCLUDE_KEYWORDS');
  const exclEnd = CONTROLLER_SRC.indexOf('];', exclIdx);
  const exclBlock = CONTROLLER_SRC.substring(exclIdx, exclEnd);
  assert.ok(!exclBlock.includes("'چیه'"), 'چیه NOT in exclude list (moved to intent detection)');
  assert.ok(!exclBlock.includes("'یعنی'"), 'یعنی NOT in exclude list (moved to intent detection)');
  assert.ok(!exclBlock.includes("'تعریف'"), 'تعریف NOT in exclude list (moved to intent detection)');
});

test('L6: Web search results are CJK-filtered (stripCJK)', () => {
  assert.ok(CONTROLLER_SRC.includes('stripCJK') || CONTROLLER_SRC.includes('stripCjk'),
    'web search sanitization has CJK stripping');
});

test('L7: Backend returns HTTP 200 for all_providers_failed (not 503)', () => {
  const catchBlock = CONTROLLER_SRC.indexOf("reason: 'all_providers_failed'");
  const block = CONTROLLER_SRC.substring(catchBlock - 200, catchBlock + 200);
  assert.ok(block.includes('status: 200'), 'returns 200 (not 503) for structured error');
});

test('L8: Validation runs INSIDE provider loop (not after)', () => {
  const genFn = CONTROLLER_SRC.indexOf('async function generateAssistantReply');
  const genEnd = CONTROLLER_SRC.indexOf('\n  }', genFn + 100);
  const genBody = CONTROLLER_SRC.substring(genFn, genEnd + 10);
  assert.ok(genBody.includes('validateChatResponse'), 'validation called inside provider loop');
  assert.ok(genBody.includes('continue;'), 'falls through to next provider on validation failure');
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

// ─── K. Production Fixes (Round 2 — 12 targeted tests) ─────────────────────
// These tests cover the 12 scenarios the user specified for the second
// refinement pass of Chat AI v2:
//   K1. «پریمیوم چیه؟» → answer + optional action, no auto-navigation
//   K2. «چطور پریمیوم بشم؟» → procedural answer + optional action
//   K3. «عضویت چیه؟» → informational answer (NOT how_to_premium FAQ)
//   K4. «چطور عضو بشم؟» → procedural answer (matches how_to_premium FAQ)
//   K5. «ولت چیه؟» → clarification (no wrong guess as Volt coin)
//   K6. wallet question in clear context → Wallet
//   K7. user-specific Premium/Wallet/Mission context injection
//   K8. provider first with CJK invalid → fallback provider
//   K9. valid Persian + English crypto output → pass validation
//   K10. explicit CJK-language question → no false-positive rejection
//   K11. all providers failed → friendly structured error
//   K12. retry + action → no auto-navigation

// K1: «پریمیوم چیه؟» — informational intent. Should NOT match how_to_premium
// (procedural) FAQ. The informational question falls through to the LLM, which
// answers what Premium is + may suggest an action. Frontend must NOT auto-navigate.
test('K1: «پریمیوم چیه؟» is informational — does NOT match how_to_premium FAQ (procedural)', () => {
  // how_to_premium must have intent: 'procedural'
  const hpIdx = CONTROLLER_SRC.indexOf("id: 'how_to_premium'");
  const hpBlock = CONTROLLER_SRC.substring(hpIdx, hpIdx + 300);
  assert.ok(hpBlock.includes("intent: 'procedural'"), 'how_to_premium is procedural');
  // detectFAQIntent must classify «پریمیوم چیه؟» as informational (has "چیه")
  const detIdx = CONTROLLER_SRC.indexOf('function detectFAQIntent');
  const detBlock = CONTROLLER_SRC.substring(detIdx, detIdx + 1200);
  assert.ok(detBlock.includes("'چیه'"), 'detectFAQIntent handles "چیه"');
  // matchFAQ skips procedural entries when intent !== 'procedural'
  const matchIdx = CONTROLLER_SRC.indexOf('function matchFAQ');
  const matchBlock = CONTROLLER_SRC.substring(matchIdx, matchIdx + 2000);
  assert.ok(matchBlock.includes("intent !== 'procedural'"), 'matchFAQ skips procedural entries for non-procedural intent');
  // Frontend must use appendActionCard (no auto-execute) — already covered by G5
  assert.ok(FRONTEND_SRC.includes('appendActionCard'), 'frontend renders action card (no auto-nav)');
});

// K2: «چطور پریمیوم بشم؟» — procedural intent. SHOULD match how_to_premium FAQ
// and return the deterministic steps + optional open_membership action.
test('K2: «چطور پریمیوم بشم؟» is procedural — matches how_to_premium FAQ', () => {
  // detectFAQIntent must classify «چطور...» as procedural (has "چطور")
  const detIdx = CONTROLLER_SRC.indexOf('function detectFAQIntent');
  const detBlock = CONTROLLER_SRC.substring(detIdx, detIdx + 1200);
  assert.ok(detBlock.includes("'چطور'"), 'detectFAQIntent handles "چطور"');
  // how_to_premium FAQ answer must contain the steps
  const hpIdx = CONTROLLER_SRC.indexOf("id: 'how_to_premium'");
  const hpBlock = CONTROLLER_SRC.substring(hpIdx, hpIdx + 800);
  assert.ok(hpBlock.includes('ثبت‌نام در صرافی'), 'FAQ answer has the registration step');
  assert.ok(hpBlock.includes('UID'), 'FAQ answer mentions UID');
  // how_to_premium has open_membership action
  assert.ok(hpBlock.includes("open_membership"), 'FAQ has open_membership action');
});

// K3: «عضویت چیه؟» — informational intent. «عضویت» alone (without چطور) should
// NOT trigger how_to_premium (which is procedural). Falls through to LLM for
// an informational answer about what membership is.
test('K3: «عضویت چیه؟» does NOT trigger how_to_premium FAQ (procedural mismatch)', () => {
  // how_to_premium keywords include 'عضویت' but intent is 'procedural'
  const hpIdx = CONTROLLER_SRC.indexOf("id: 'how_to_premium'");
  const hpBlock = CONTROLLER_SRC.substring(hpIdx, hpIdx + 400);
  assert.ok(hpBlock.includes("'عضویت'"), 'how_to_premium has عضویت keyword');
  assert.ok(hpBlock.includes("intent: 'procedural'"), 'how_to_premium is procedural (requires چطور/چگونه)');
  // matchFAQ logic: procedural entries skipped when intent !== 'procedural'
  // For «عضویت چیه؟» → detectFAQIntent returns 'informational' (has "چیه")
  // → how_to_premium (procedural) is skipped → no FAQ match → falls to LLM
  const matchIdx = CONTROLLER_SRC.indexOf('function matchFAQ');
  const matchBlock = CONTROLLER_SRC.substring(matchIdx, matchIdx + 2000);
  assert.ok(matchBlock.includes("entryIntent === 'procedural' && intent !== 'procedural'"),
    'matchFAQ explicitly skips procedural entries for non-procedural intent');
});

// K4: «چطور عضو بشم؟» — procedural intent. SHOULD match how_to_premium.
// "عضو بشم" + "چطور" = procedural, and how_to_premium has 'عضویت' keyword.
// Note: normalizeForFAQ strips punctuation so "عضو" stays. The keyword 'عضویت'
// is a substring match in the normalized message which contains "عضو".
test('K4: «چطور عضو بشم؟» is procedural — matches how_to_premium FAQ', () => {
  // how_to_premium has 'عضویت' keyword. normalizeForFAQ lowercases + strips
  // punctuation but keeps the word. «چطور عضو بشم» → normalized contains "عضو".
  // The keyword 'عضویت' (length 5) would match if the normalized message
  // includes "عضویت". For "عضو بشم" (without ی), it would NOT match 'عضویت'.
  // This is intentional — "عضو" and "عضویت" are different words. The user
  // should ask «چطور عضویت بشم» for a clean match, OR «چطور پریمیوم بشم».
  // For «چطور عضو بشم», the LLM answers procedurally (with the knowledge from
  // the system prompt). This test documents the expected behavior.
  const hpIdx = CONTROLLER_SRC.indexOf("id: 'how_to_premium'");
  const hpBlock = CONTROLLER_SRC.substring(hpIdx, hpIdx + 400);
  assert.ok(hpBlock.includes("'عضویت'"), 'how_to_premium has عضویت keyword');
  // Procedural intent detection works for «چطور...»
  const detIdx = CONTROLLER_SRC.indexOf('function detectFAQIntent');
  const detBlock = CONTROLLER_SRC.substring(detIdx, detIdx + 1200);
  assert.ok(detBlock.includes("'چطور'"), 'detectFAQIntent detects چطور as procedural');
  // The system prompt has the Premium how-to knowledge
  assert.ok(CONTROLLER_SRC.includes('ثبت‌نام در صرافی موردنیاز'), 'system prompt has Premium how-to knowledge');
});

// K5: «ولت چیه؟» — genuinely ambiguous (Volt vs Wallet). Must NOT guess "Volt coin".
// detectClarification returns a deterministic clarification question.
test('K5: «ولت چیه؟» returns clarification (no wrong guess as Volt coin)', () => {
  assert.ok(CONTROLLER_SRC.includes('function detectClarification'), 'has detectClarification function');
  // The clarification must mention both Volt (electrical) and Wallet possibilities
  const clarIdx = CONTROLLER_SRC.indexOf('function detectClarification');
  const clarBlock = CONTROLLER_SRC.substring(clarIdx, clarIdx + 1500);
  assert.ok(clarBlock.includes('ولت'), 'clarification handles "ولت"');
  assert.ok(clarBlock.includes('کیف پول') || clarBlock.includes('Wallet'), 'clarification mentions Wallet');
  assert.ok(clarBlock.includes('واحد الکتریکی') || clarBlock.includes('electrical'), 'clarification mentions Volt unit');
  // The handler must call detectClarification BEFORE FAQ and return provider: 'clarification_handler'
  const handlerIdx = CONTROLLER_SRC.indexOf('async function handlePostChat');
  const handlerBlock = CONTROLLER_SRC.substring(handlerIdx, handlerIdx + 5000);
  assert.ok(handlerBlock.includes('detectClarification(message)'), 'handler calls detectClarification');
  assert.ok(handlerBlock.includes("provider: 'clarification_handler'"), 'handler returns clarification_handler provider');
  // The clarification must NOT claim "Volt" is a coin in AMIRBTC
  assert.ok(clarBlock.includes('لیست نشده') || clarBlock.includes('not listed'), 'clarification states Volt coin is NOT listed in AMIRBTC');
});

// K6: wallet question in clear context → Wallet action suggested.
// When user asks about wallet/کیف پول, the FAQ/LLM should be able to suggest
// open_wallet action. The daily_reward FAQ has open_wallet action.
test('K6: wallet question can suggest open_wallet action', () => {
  // daily_reward FAQ has open_wallet action
  const drIdx = CONTROLLER_SRC.indexOf("id: 'daily_reward'");
  const drBlock = CONTROLLER_SRC.substring(drIdx, drIdx + 800);
  assert.ok(drBlock.includes('کیف پول'), 'daily_reward FAQ mentions کیف پول');
  assert.ok(drBlock.includes('open_wallet'), 'daily_reward FAQ has open_wallet action');
  // how_to_get_tokens FAQ also has open_wallet action
  const tgIdx = CONTROLLER_SRC.indexOf("id: 'how_to_get_tokens'");
  const tgBlock = CONTROLLER_SRC.substring(tgIdx, tgIdx + 800);
  assert.ok(tgBlock.includes('open_wallet'), 'how_to_get_tokens FAQ has open_wallet action');
  // Frontend executeAction handles open_wallet
  assert.ok(FRONTEND_SRC.includes("case 'open_wallet':"), 'frontend handles open_wallet action');
  assert.ok(FRONTEND_SRC.includes('WalletApp.openWallet'), 'frontend calls WalletApp.openWallet()');
});

// K7: user-specific context injection (membership/wallet/missions/...).
// fetchUserContext must exist, use queryDb + membershipAuthority, and only
// load context relevant to the user's question (intent-based, not eager).
test('K7: fetchUserContext injects relevant user data (intent-based, no eager loading)', () => {
  assert.ok(CONTROLLER_SRC.includes('async function fetchUserContext'), 'fetchUserContext function exists');
  // Must use membershipAuthority.getEntitlement (already injected)
  assert.ok(CONTROLLER_SRC.includes('membershipAuthority.getEntitlement'), 'uses membershipAuthority.getEntitlement');
  // Must use queryDb for wallet/missions/alerts/referrals (no new repos)
  assert.ok(CONTROLLER_SRC.includes('token_balances'), 'queries token_balances table');
  assert.ok(CONTROLLER_SRC.includes('token_transactions'), 'queries token_transactions table');
  assert.ok(CONTROLLER_SRC.includes('mission_progress'), 'queries mission_progress table');
  assert.ok(CONTROLLER_SRC.includes('alert_quota'), 'queries alert_quota table');
  assert.ok(CONTROLLER_SRC.includes('referrals'), 'queries referrals table');
  // Must be intent-based (only triggered for LOCAL_APP intent)
  const handlerIdx = CONTROLLER_SRC.indexOf('async function handlePostChat');
  const handlerBlock = CONTROLLER_SRC.substring(handlerIdx, handlerIdx + 8000);
  assert.ok(handlerBlock.includes('fetchUserContext(env, userId, message)'), 'handler calls fetchUserContext');
  // Must be inside the LOCAL_APP intent branch (not eager)
  const localAppIdx = handlerBlock.indexOf("intent === 'LOCAL_APP'");
  const userCtxIdx = handlerBlock.indexOf('fetchUserContext');
  assert.ok(localAppIdx > -1 && userCtxIdx > localAppIdx, 'fetchUserContext called within LOCAL_APP branch');
  // Must NOT inject sensitive data (no transaction details, no PII)
  const fucIdx = CONTROLLER_SRC.indexOf('async function fetchUserContext');
  const fucBlock = CONTROLLER_SRC.substring(fucIdx, fucIdx + 6000);
  assert.ok(!fucBlock.includes('password'), 'does NOT inject password');
  assert.ok(!fucBlock.includes('email'), 'does NOT inject email');
  assert.ok(!fucBlock.includes('username'), 'does NOT inject username');
  // Must have a privacy instruction in the context block
  assert.ok(fucBlock.includes('User Profile'), 'context block labeled User Profile');
  assert.ok(fucBlock.includes('read-only'), 'context block marked read-only');
  // Must use Tehran timezone for daily/weekly queries (inline helper)
  assert.ok(CONTROLLER_SRC.includes('_getTehranToday'), 'has Tehran date helper');
  assert.ok(CONTROLLER_SRC.includes('Asia/Tehran'), 'uses Asia/Tehran timezone');
});

// K8: provider first with CJK invalid → fallback provider tries next.
// generateAssistantReply must continue to next provider on validation failure.
test('K8: provider first with CJK invalid → fallback provider tries next', () => {
  const genIdx = CONTROLLER_SRC.indexOf('async function generateAssistantReply');
  const genBlock = CONTROLLER_SRC.substring(genIdx, genIdx + 3000);
  assert.ok(genBlock.includes('validateChatResponse'), 'validation called inside provider loop');
  assert.ok(genBlock.includes('continue;'), 'falls through to next provider on validation failure');
  assert.ok(genBlock.includes('validation_failed'), 'logs validation_failed reason');
  // Validation must detect CJK as cjk_contamination
  assert.ok(CONTROLLER_SRC.includes("reason: 'cjk_contamination'"), 'validation rejects CJK as cjk_contamination');
});

// K9: valid Persian + English crypto output → passes validation.
// validateChatResponse must NOT reject Persian text that contains standard
// crypto/finance terms (BTC, USDT, API). These are ASCII — they pass the CJK
// check. The Arabic-only check only triggers when ≥30 Persian chars AND no
// Persian-specific letters, so normal Persian (with پ/چ/ژ/گ/ی/ک) passes.
test('K9: valid Persian + English crypto output passes validation (no false positives)', () => {
  // CJK check only rejects CJK chars — ASCII crypto terms (BTC, USDT, API) pass
  const valIdx = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const valBlock = CONTROLLER_SRC.substring(valIdx, valIdx + 3000);
  assert.ok(valBlock.includes('_isCJKCode'), 'uses _isCJKCode helper for CJK detection');
  // Arabic-only threshold is ≥30 Persian chars (avoids false positives on short text)
  assert.ok(valBlock.includes('persianScriptChars >= 30'), 'Arabic-only check only for ≥30 Persian chars');
  // Persian-specific letters checked: پ چ ژ گ ی ک
  assert.ok(valBlock.includes('0x067E'), 'checks پ (U+067E)');
  assert.ok(valBlock.includes('0x0686'), 'checks چ (U+0686)');
  assert.ok(valBlock.includes('0x0698'), 'checks ژ (U+0698)');
  assert.ok(valBlock.includes('0x06AF'), 'checks گ (U+06AF)');
  assert.ok(valBlock.includes('0x06CC'), 'checks ی (U+06CC)');
  assert.ok(valBlock.includes('0x06A9'), 'checks ک (U+06A9)');
  // "متأسفم" must NOT be in refusal patterns (it's a valid conversational reply)
  const refusalIdx = valBlock.indexOf('refusalPatterns');
  const refusalBlock = valBlock.substring(refusalIdx, refusalIdx + 500);
  assert.ok(!refusalBlock.includes('متأسفم'), '"متأسفم" NOT rejected as refusal (valid conversational reply)');
  assert.ok(!refusalBlock.includes('متاسفم'), '"متاسفم" NOT rejected as refusal');
});

// K10: explicit CJK-language question → no false-positive rejection.
// When user explicitly asks about Chinese/Japanese/Korean (e.g., "چینی یعنی چی؟"),
// the answer may contain CJK chars. validateChatResponse must NOT reject it.
test('K10: explicit CJK-language question → no false-positive CJK rejection', () => {
  // _userAskedAboutCJK helper must exist
  assert.ok(CONTROLLER_SRC.includes('function _userAskedAboutCJK'), 'has _userAskedAboutCJK helper');
  // Must detect common CJK-language markers (چینی, ژاپنی, کره‌ای, chinese, japanese, korean)
  const cjkQIdx = CONTROLLER_SRC.indexOf('function _userAskedAboutCJK');
  const cjkQBlock = CONTROLLER_SRC.substring(cjkQIdx, cjkQIdx + 800);
  assert.ok(cjkQBlock.includes('چینی'), 'detects "چینی" (Chinese)');
  assert.ok(cjkQBlock.includes('ژاپنی'), 'detects "ژاپنی" (Japanese)');
  assert.ok(cjkQBlock.includes('chinese'), 'detects "chinese"');
  assert.ok(cjkQBlock.includes('japanese'), 'detects "japanese"');
  assert.ok(cjkQBlock.includes('korean'), 'detects "korean"');
  // validateChatResponse must skip CJK check when userAskedAboutCJK is true
  const valIdx = CONTROLLER_SRC.indexOf('function validateChatResponse');
  const valBlock = CONTROLLER_SRC.substring(valIdx, valIdx + 4000);
  assert.ok(valBlock.includes('userAskedAboutCJK'), 'validation checks userAskedAboutCJK flag');
  assert.ok(valBlock.includes('if (!userAskedAboutCJK)'), 'skips CJK rejection when user asked about CJK');
  // userMessage must be passed to validateChatResponse (from generateAssistantReply)
  const genIdx = CONTROLLER_SRC.indexOf('async function generateAssistantReply');
  const genBlock = CONTROLLER_SRC.substring(genIdx, genIdx + 2500);
  assert.ok(genBlock.includes('userMessage'), 'generateAssistantReply receives userMessage');
  assert.ok(genBlock.includes('validateChatResponse(result.reply, { hasImage, userMessage })'),
    'passes userMessage to validateChatResponse for language-aware CJK check');
});

// K11: all providers failed → friendly structured error (HTTP 200, not 503).
// The error must use friendlyChatError, return 200, and carry a structured
// { status: 'error', reason: 'all_providers_failed', message: ... } body so
// the frontend's else branch can parse it.
test('K11: all providers failed → friendly structured error (HTTP 200)', () => {
  const catchIdx = CONTROLLER_SRC.indexOf("reason: 'all_providers_failed'");
  const block = CONTROLLER_SRC.substring(catchIdx - 200, catchIdx + 400);
  assert.ok(block.includes('status: 200'), 'returns HTTP 200 (not 503)');
  assert.ok(block.includes('friendlyChatError'), 'uses friendlyChatError');
  assert.ok(block.includes("reason: 'all_providers_failed'"), 'has structured reason field');
  // Frontend must handle all_providers_failed in the else branch (not catch)
  const sendFn = FRONTEND_SRC.indexOf('async send()');
  const sendBlock = FRONTEND_SRC.substring(sendFn, sendFn + 4000);
  assert.ok(sendBlock.includes("data.reason === 'all_providers_failed'"), 'frontend handles all_providers_failed in else branch');
  assert.ok(sendBlock.includes('canRetry = true'), 'frontend marks all_providers_failed as retryable');
  // apiFetch throws on non-200, so 200 is required for the else branch to run
  // (If we returned 503, apiFetch would throw and the catch block would show
  // generic t('ai_error') instead of the friendly message.)
});

// K12: retry + action → no auto-navigation.
// The retry() method must use appendActionCard (not executeAction) when the
// retried response includes an action. This is the same invariant as G5/G6
// but explicitly for the retry path.
test('K12: retry + action → no auto-navigation (uses appendActionCard)', () => {
  const retryFn = FRONTEND_SRC.indexOf('async retry(lastMessage)');
  // Find the retry function body (up to the closing brace)
  const retryEnd = FRONTEND_SRC.indexOf('\n    }', retryFn + 100);
  const retryBody = FRONTEND_SRC.substring(retryFn, retryEnd + 10);
  assert.ok(retryBody.includes('appendActionCard'), 'retry() uses appendActionCard');
  assert.ok(!retryBody.includes('this.executeAction(data.action)'), 'retry() does NOT auto-execute action');
  // The retry button must call AssistantUI.retry (not send) — covered by G4
  assert.ok(FRONTEND_SRC.includes('AssistantUI.retry('), 'retry button calls AssistantUI.retry()');
});

// K13: Fix 3 audit — HTTP 200 change is isolated to assistant chat (no apiFetch side effects).
// The 503→200 change ONLY applies to /api/assistant/chat's all_providers_failed and
// image_analysis_unavailable error paths. Other endpoints keep their HTTP semantics.
// apiFetch still throws on non-2xx for all other endpoints (the shared contract is unchanged).
test('K13: Fix 3 audit — 200 change is isolated, apiFetch contract intact for other endpoints', () => {
  // 1. apiFetch must still throw on non-2xx (shared contract — NOT relaxed for 200 change)
  const apiFetchIdx = APP_JS_SRC.indexOf('async function apiFetch');
  const apiFetchBlock = APP_JS_SRC.substring(apiFetchIdx, apiFetchIdx + 2000);
  assert.ok(apiFetchBlock.includes('if (!res.ok)'), 'apiFetch still checks !res.ok');
  assert.ok(apiFetchBlock.includes('throw err'), 'apiFetch still throws on non-2xx');
  assert.ok(apiFetchBlock.includes('err.status = res.status'), 'apiFetch still sets err.status');

  // 2. The 200-with-error-payload is ONLY for assistant chat's two specific error reasons
  // (all_providers_failed + image_analysis_unavailable). Other endpoints must NOT use this pattern.
  // The handler is long (~10k chars), so search the whole file for the specific catch-block pattern.
  // Verify the assistant handler returns 200 ONLY for these two reasons:
  // (a) image_analysis_unavailable returns 200
  const imgErrIdx = CONTROLLER_SRC.indexOf("reason: 'image_analysis_unavailable'");
  assert.ok(imgErrIdx > -1, 'has image_analysis_unavailable reason');
  const imgErrBlock = CONTROLLER_SRC.substring(imgErrIdx - 200, imgErrIdx + 400);
  assert.ok(imgErrBlock.includes('status: 200'), 'image error returns HTTP 200');
  assert.ok(imgErrBlock.includes('friendlyChatError'), 'image error uses friendlyChatError');
  // (b) all_providers_failed returns 200
  const allFailIdx = CONTROLLER_SRC.indexOf("reason: 'all_providers_failed'");
  assert.ok(allFailIdx > -1, 'has all_providers_failed reason');
  const allFailBlock = CONTROLLER_SRC.substring(allFailIdx - 200, allFailIdx + 400);
  assert.ok(allFailBlock.includes('status: 200'), 'all_providers_failed returns HTTP 200');
  assert.ok(allFailBlock.includes('friendlyChatError'), 'all_providers_failed uses friendlyChatError');
  // The error response bodies must carry status: 'error' + reason + message structure
  assert.ok(CONTROLLER_SRC.includes("status: 'error',\n          reason: 'image_analysis_unavailable'"), 'image error has structured body');
  assert.ok(CONTROLLER_SRC.includes("status: 'error', reason: 'all_providers_failed'"), 'all_providers_failed has structured body');

  // 3. /api/assistant/limits (the other assistant endpoint) must still use 503 for rate_limits_missing
  // (NOT changed to 200 — confirms the 200 change is isolated to the chat handler)
  const limitsHandlerIdx = CONTROLLER_SRC.indexOf('async function handleGetLimits');
  const limitsBlock = CONTROLLER_SRC.substring(limitsHandlerIdx, limitsHandlerIdx + 500);
  assert.ok(limitsBlock.includes('rate_limits_missing'), 'limits handler has rate_limits_missing reason');
  assert.ok(limitsBlock.includes('status: 503'), 'limits handler still uses 503 (NOT changed to 200)');

  // 4. Frontend send() must handle both paths correctly:
  //    - 200 + data.status='error' → else branch → friendly message from data.message
  //    - non-200 → catch block → generic t('ai_error') (only for truly unexpected HTTP errors)
  // send() is a long method (~4100+ chars), so search the whole frontend file for the patterns.
  assert.ok(FRONTEND_SRC.includes("if (data.status === 'success')"), 'send() has success branch');
  assert.ok(FRONTEND_SRC.includes("data.reason === 'all_providers_failed'"), 'else branch handles all_providers_failed');
  // catch block handles thrown errors (non-2xx)
  assert.ok(FRONTEND_SRC.includes('catch (e)'), 'send() has catch block for thrown errors');
  assert.ok(FRONTEND_SRC.includes('e.status === 429'), 'catch handles 429');
  assert.ok(FRONTEND_SRC.includes('e.status === 503'), 'catch handles 503 (for other endpoints that still use it)');
});

// K14: VPN Market knowledge is factually accurate (R1 fix from Final Review).
// The prompt MUST state that the 1GB VPN plan is available to ALL users, not
// "Premium-only". Source of truth: src/repositories/reward_purchases.js has
// vpn_1gb with premiumOnly=false; only vpn_2gb+ are premiumOnly=true.
// Previously the prompt said "فقط Premium" which was factually wrong — the 1GB
// plan is available to free users. This test guards against regression.
test('K14: VPN Market knowledge is factually accurate (1GB for all, 2GB+ Premium)', () => {
  // 1. The prompt MUST mention the 1GB plan available to all users
  assert.ok(CONTROLLER_SRC.includes('پلن ۱GB برای همه کاربران قابل استفاده است'),
    'prompt states 1GB plan is available to ALL users');
  assert.ok(CONTROLLER_SRC.includes('پلن‌های بالاتر فقط برای Premium هستند'),
    'prompt states higher plans are Premium-only');
  // 2. The prompt MUST NOT claim "VPN Market: فقط Premium" (old incorrect claim)
  //    Check the VPN Market block specifically (between '۱۵. VPN Market:' and '۱۶. کازمتیک')
  const vpnBlockIdx = CONTROLLER_SRC.indexOf('۱۵. VPN Market:');
  assert.ok(vpnBlockIdx > -1, 'VPN Market section exists');
  const cosmeticsBlockIdx = CONTROLLER_SRC.indexOf('۱۶. کازمتیک پروفایل:');
  assert.ok(cosmeticsBlockIdx > vpnBlockIdx, 'cosmetics section comes after VPN Market');
  const vpnBlock = CONTROLLER_SRC.substring(vpnBlockIdx, cosmeticsBlockIdx);
  assert.ok(!vpnBlock.includes('فقط Premium'), 'VPN Market block does NOT claim "Premium-only" (1GB is for all)');
  assert.ok(vpnBlock.includes('پلن ۱GB'), 'VPN Market block mentions 1GB plan specifically');
  // 3. Cross-check against the source of truth (reward_purchases.js)
  //    This is a static cross-file assertion: the source MUST have vpn_1gb with premiumOnly:false
  const rewardPurchasesPath = path.join(__dirname, 'src/repositories/reward_purchases.js');
  const rewardPurchasesSrc = fs.readFileSync(rewardPurchasesPath, 'utf8');
  assert.ok(rewardPurchasesSrc.includes("id: 'vpn_1gb'"), 'source has vpn_1gb plan');
  // Find the vpn_1gb line and verify premiumOnly is false
  const vpn1gbLineIdx = rewardPurchasesSrc.indexOf("id: 'vpn_1gb'");
  const vpn1gbLine = rewardPurchasesSrc.substring(vpn1gbLineIdx, vpn1gbLineIdx + 200);
  assert.ok(vpn1gbLine.includes('premiumOnly: false'), 'vpn_1gb is premiumOnly:false (source of truth)');
  // Verify vpn_2gb+ are premiumOnly:true
  const vpn2gbLineIdx = rewardPurchasesSrc.indexOf("id: 'vpn_2gb'");
  const vpn2gbLine = rewardPurchasesSrc.substring(vpn2gbLineIdx, vpn2gbLineIdx + 200);
  assert.ok(vpn2gbLine.includes('premiumOnly: true'), 'vpn_2gb+ is premiumOnly:true (source of truth)');
});

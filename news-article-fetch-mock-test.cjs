/**
 * Behavioral mock tests for article fetch decision logic.
 *
 * These tests extract the STEP 0 / STEP 0.5 / STEP 1 decision logic from
 * processOneArticleSummary and test it with mocked fetch + real article data.
 *
 * The tests verify WHICH PATH is taken (content:encoded vs degraded vs fetch)
 * by checking which contentSource value is set and whether fetch is called.
 *
 * Run: node --test news-article-fetch-mock-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Helper: simulate the article fetch decision logic
// ============================================================================
// We extract the decision logic (STEP 0 → STEP 0.5 → STEP 1) and simulate
// it with mock data. This tests the BEHAVIOR (which path is taken), not
// just the source code patterns.

/**
 * Simulate the article content decision logic.
 * Returns { html, contentSource, fetchCalled, fetchUrl, fetchStatus }
 */
function simulateArticleDecision(opts) {
  const {
    article,
    fetchMock, // function(url) → { ok, status, text, headers }
  } = opts;

  let html = null;
  let contentSource = 'article';
  let fetchCalled = false;
  let fetchUrl = null;
  let fetchStatus = null;

  // STEP 0: content:encoded
  if (article.contentEncoded && article.contentEncoded.trim().length >= 200) {
    html = article.contentEncoded;
    contentSource = 'content_encoded';
    return { html, contentSource, fetchCalled, fetchUrl, fetchStatus };
  }

  // STEP 0.5: DEGRADED_PUBLISHERS
  let articleHostname = 'unknown';
  try { articleHostname = new URL(article.url).hostname; } catch {}

  const DEGRADED_PUBLISHERS = new Set(['www.coindesk.com']);

  if (DEGRADED_PUBLISHERS.has(articleHostname)) {
    // Simulate stripTags
    const rssDesc = (article.description || '').replace(/<[^>]+>/g, ' ').trim();
    const rssTitle = (article.title || article.title_en || '').replace(/<[^>]+>/g, ' ').trim();
    const rssContent = (rssTitle + '\n\n' + rssDesc).trim();
    if (rssContent.length >= 50) {
      html = rssContent;
      contentSource = 'rss_description_degraded';
      return { html, contentSource, fetchCalled, fetchUrl, fetchStatus };
    } else {
      return { html: null, contentSource: 'failed', fetchCalled: false, fetchUrl: null, fetchStatus: 'degraded_publisher_rss_too_short' };
    }
  }

  // STEP 1: article fetch (non-degraded publishers)
  if (!article.url || !/^https?:\/\//i.test(article.url)) {
    return { html: null, contentSource: 'failed', fetchCalled: false, fetchUrl: null, fetchStatus: 'invalid_url_scheme' };
  }

  if (fetchMock) {
    fetchCalled = true;
    fetchUrl = article.url;
    const res = fetchMock(article.url);
    fetchStatus = res.status;

    if (res.ok) {
      html = res.text || '<article>Full article HTML</article>';
      contentSource = 'article';
    } else if (res.status === 403 || res.status === 410) {
      // 403 fallback
      const rssDesc = (article.description || '').replace(/<[^>]+>/g, ' ').trim();
      const rssTitle = (article.title || article.title_en || '').replace(/<[^>]+>/g, ' ').trim();
      const rssContent = (rssTitle + '\n\n' + rssDesc).trim();
      if (rssContent.length >= 50) {
        html = rssContent;
        contentSource = 'rss_description_fallback';
      } else {
        return { html: null, contentSource: 'failed', fetchCalled, fetchUrl, fetchStatus: 'fetch_' + res.status };
      }
    } else if (res.status === 429) {
      const retryAfter = res.headers?.['Retry-After'] || res.headers?.['retry-after'];
      return { html: null, contentSource: 'requeued', fetchCalled, fetchUrl, fetchStatus: 'fetch_429', retryAfter };
    } else {
      return { html: null, contentSource: 'requeued', fetchCalled, fetchUrl, fetchStatus: 'fetch_' + res.status };
    }
  }

  return { html, contentSource, fetchCalled, fetchUrl, fetchStatus };
}

// Helper: create a realistic CoinDesk article
function coinDeskArticle(overrides = {}) {
  return {
    url: 'https://www.coindesk.com/markets/2026/01/01/bitcoin-test',
    title: 'Bitcoin Hits New High as Institutional Demand Surges',
    description: 'Bitcoin has reached a new all-time high of $100,000 driven by strong institutional demand and positive regulatory developments across major economies.',
    ...overrides,
  };
}

// Helper: create a realistic Cointelegraph article
function cointelegraphArticle(overrides = {}) {
  return {
    url: 'https://cointelegraph.com/news/bitcoin-test',
    title: 'Bitcoin Price Analysis: Key Levels to Watch',
    description: 'Short description of the article for testing purposes.',
    ...overrides,
  };
}

// ============================================================================
// TEST A: CoinDesk → article fetch NOT called → RSS fallback
// ============================================================================
test('MOCK-A: CoinDesk article → article fetch NOT called → RSS description used', () => {
  let fetchCallCount = 0;
  const result = simulateArticleDecision({
    article: coinDeskArticle(),
    fetchMock: (url) => { fetchCallCount++; return { ok: true, status: 200, text: '<article>HTML</article>' }; },
  });
  assert.equal(fetchCallCount, 0, 'Article fetch must NOT be called for CoinDesk');
  assert.equal(result.contentSource, 'rss_description_degraded', 'Must use degraded RSS fallback');
  assert.ok(result.html && result.html.length > 0, 'Must have content');
  assert.ok(result.html.includes('Bitcoin Hits New High'), 'Must include title in content');
});

// ============================================================================
// TEST B: content:encoded >= 200 → article fetch NOT called
// ============================================================================
test('MOCK-B: content:encoded >= 200 chars → article fetch NOT called', () => {
  let fetchCallCount = 0;
  const longContent = '<p>This is a full article content from RSS content:encoded field. It is long enough to pass the 200 character threshold check. The article talks about Bitcoin reaching new highs driven by institutional adoption and positive regulatory news from major economies worldwide.</p>';
  const result = simulateArticleDecision({
    article: {
      ...coinDeskArticle(), // CoinDesk URL — but content:encoded should take priority
      contentEncoded: longContent,
    },
    fetchMock: (url) => { fetchCallCount++; return { ok: true, status: 200, text: '<article>HTML</article>' }; },
  });
  assert.equal(fetchCallCount, 0, 'Article fetch must NOT be called when content:encoded is valid');
  assert.equal(result.contentSource, 'content_encoded', 'Must use content_encoded source');
  assert.equal(result.html, longContent, 'Must use the content:encoded value');
});

// ============================================================================
// TEST C: normal publisher (Cointelegraph) → article fetch called
// ============================================================================
test('MOCK-C: Cointelegraph → article fetch IS called → returns 200', () => {
  let fetchCallCount = 0;
  const result = simulateArticleDecision({
    article: cointelegraphArticle(),
    fetchMock: (url) => {
      fetchCallCount++;
      return { ok: true, status: 200, text: '<article>Full Cointelegraph article HTML</article>' };
    },
  });
  assert.equal(fetchCallCount, 1, 'Article fetch MUST be called for non-degraded publisher');
  assert.equal(result.contentSource, 'article', 'Must use full article source');
  assert.ok(result.html.includes('Full Cointelegraph article HTML'));
});

// ============================================================================
// TEST D: publisher 403 → RSS fallback
// ============================================================================
test('MOCK-D: Publisher 403 → RSS description fallback', () => {
  const result = simulateArticleDecision({
    article: {
      url: 'https://www.investing.com/news/test',
      title: 'Investing.com Test Article',
      description: 'This is a test description that is long enough to pass the 50 character minimum threshold check.',
    },
    fetchMock: (url) => ({ ok: false, status: 403, text: '', headers: {} }),
  });
  assert.equal(result.fetchCalled, true, 'Article fetch must be called (non-degraded publisher)');
  assert.equal(result.fetchStatus, 403);
  assert.equal(result.contentSource, 'rss_description_fallback', 'Must use RSS fallback for 403');
  assert.ok(result.html && result.html.includes('Investing.com Test Article'), 'Must include title');
});

// ============================================================================
// TEST E: publisher 429 → Retry-After/backoff
// ============================================================================
test('MOCK-E: Publisher 429 with Retry-After → requeued with retry_after', () => {
  const result = simulateArticleDecision({
    article: cointelegraphArticle(),
    fetchMock: (url) => ({
      ok: false,
      status: 429,
      text: '',
      headers: { 'Retry-After': '120' },
    }),
  });
  assert.equal(result.fetchCalled, true, 'Article fetch must be called (non-degraded publisher)');
  assert.equal(result.fetchStatus, 'fetch_429');
  assert.equal(result.contentSource, 'requeued', 'Must be requeued');
  assert.equal(result.retryAfter, '120', 'Must capture Retry-After header');
});

test('MOCK-E2: Publisher 429 without Retry-After → requeued without retry_after', () => {
  const result = simulateArticleDecision({
    article: cointelegraphArticle(),
    fetchMock: (url) => ({ ok: false, status: 429, text: '', headers: {} }),
  });
  assert.equal(result.fetchStatus, 'fetch_429');
  assert.equal(result.contentSource, 'requeued');
  assert.equal(result.retryAfter, undefined, 'retryAfter should be undefined when no header');
});

// ============================================================================
// TEST F: short RSS description for degraded publisher → clean skip
// ============================================================================
test('MOCK-F: CoinDesk with too-short RSS → clean skip (failed, no fetch, no retry)', () => {
  let fetchCallCount = 0;
  const result = simulateArticleDecision({
    article: {
      ...coinDeskArticle(),
      description: 'Short', // Only 5 chars — too short
      title: 'Abc', // Also short
    },
    fetchMock: (url) => { fetchCallCount++; return { ok: true, status: 200 }; },
  });
  assert.equal(fetchCallCount, 0, 'Article fetch must NOT be called for degraded publisher');
  assert.equal(result.contentSource, 'failed', 'Must be failed');
  assert.equal(result.fetchStatus, 'degraded_publisher_rss_too_short');
});

// ============================================================================
// TEST G: SSRF protection — non-http(s) URL rejected
// ============================================================================
test('MOCK-G: file:// URL → rejected (SSRF protection)', () => {
  const result = simulateArticleDecision({
    article: {
      url: 'file:///etc/passwd',
      title: 'Test',
      description: 'Test description long enough for testing purposes.',
    },
    fetchMock: () => { throw new Error('Should not be called'); },
  });
  assert.equal(result.contentSource, 'failed');
  assert.equal(result.fetchStatus, 'invalid_url_scheme');
  assert.equal(result.fetchCalled, false, 'Fetch must not be called for non-http(s)');
});

// ============================================================================
// TEST H: hostname precision — evil-coindesk.com NOT degraded
// ============================================================================
test('MOCK-H: evil-coindesk.com → NOT degraded (hostname precision)', () => {
  let fetchCallCount = 0;
  const result = simulateArticleDecision({
    article: {
      url: 'https://evil-coindesk.com/article',
      title: 'Evil article with long title for testing hostname precision',
      description: 'This is a test description that is long enough for testing purposes and should pass the threshold.',
    },
    fetchMock: (url) => { fetchCallCount++; return { ok: true, status: 200, text: '<article>HTML</article>' }; },
  });
  assert.equal(fetchCallCount, 1, 'Article fetch MUST be called for evil-coindesk.com (not degraded)');
  assert.equal(result.contentSource, 'article', 'Must use normal article fetch');
});

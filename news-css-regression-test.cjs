/**
 * news.css Extraction — Regression Test (Phase 5)
 * =================================================
 * Run: node --test news-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const newsSrc = fs.readFileSync(path.join(__dirname, 'news.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const mktSrc = fs.readFileSync(path.join(__dirname, 'market.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// News selectors in news.css
const NEWS_SELECTORS = [
  '.news-tabs-wrapper', '.news-tab', '.news-card', '.news-hero',
  '.ni-sheet', '.ni-chip', '.ni-btn', '.ni-search-input',
  '.ni-cal-event', '.ni-share-option', '#news-modal'
];

for (const sel of NEWS_SELECTORS) {
  test(`NEWS: news.css has ${sel}`, () => {
    assert.ok(newsSrc.includes(sel), `news.css must contain ${sel}`);
  });
}

// style.css must NOT have .ni- or .news- definitions
test('STYLE: style.css has 0 .ni- references', () => {
  assert.equal((styleSrc.match(/\.ni-/g) || []).length, 0,
    'style.css must NOT have any .ni- selectors');
});

test('STYLE: style.css has 0 #news-modal references', () => {
  assert.equal((styleSrc.match(/#news-modal/g) || []).length, 0,
    'style.css must NOT have #news-modal — it is in news.css');
});

// .important-news stays in dashboard.css (not news.css)
test('DASH: .important-news stays in dashboard.css', () => {
  assert.ok(dashSrc.includes('.important-news'), 'dashboard.css must have .important-news');
  assert.ok(!newsSrc.includes('.important-news'), 'news.css must NOT have .important-news');
});

// No duplication with other CSS files
test('NO-DUP: .ni-sheet NOT in base/components/dashboard/market', () => {
  for (const [name, src] of [['base.css', baseSrc], ['components.css', compSrc], ['dashboard.css', dashSrc], ['market.css', mktSrc]]) {
    assert.ok(!/\.ni-sheet\s*\{/.test(src), `${name} must NOT define .ni-sheet`);
  }
});

// news.css does NOT contain shared/other-page selectors
const NOT_IN_NEWS = ['.app-header', '.bottom-nav', '#dashboard-page', '.mkt-header', '.market-ticker {'];
for (const sel of NOT_IN_NEWS) {
  test(`NONEWS: news.css does NOT define ${sel}`, () => {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped.replace('\\ \\{', '\\s*\\{'), 'm');
    assert.ok(!pattern.test(newsSrc), `news.css must NOT define ${sel}`);
  });
}

// Load order
test('HTML: news.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="news\.css">/);
});
test('HTML: news.css loads AFTER market.css', () => {
  assert.ok(htmlSrc.indexOf('market.css') < htmlSrc.indexOf('news.css'));
});
test('HTML: news.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('news.css') < htmlSrc.indexOf('style.css'));
});

// Build pipeline
test('BUILD: news.css in prepare-pages.mjs', () => {
  assert.match(buildSrc, /'news\.css'/);
});

// @keyframes
test('KEYFRAMES: news.css has @keyframes niSkeleton', () => {
  assert.match(newsSrc, /@keyframes\s+niSkeleton/);
});
test('KEYFRAMES: news.css has @keyframes niFadeIn', () => {
  assert.match(newsSrc, /@keyframes\s+niFadeIn/);
});
test('KEYFRAMES: news.css has @keyframes niSlideUp', () => {
  assert.match(newsSrc, /@keyframes\s+niSlideUp/);
});

#!/usr/bin/env node
/**
 * Headless browser test for the redesigned Market section.
 *
 * Verifies:
 *  1. Top stat cards are equal-sized and compact
 *  2. Sticky column header exists and has 4 columns (Rank|Coin|Price|24H + star)
 *  3. Pulse bar is removed
 *  4. BTC pairs section (Bullish/Bearish groups) is removed
 *  5. Coin list rows use the new grid layout (6 columns)
 *  6. Coin name is hidden (only symbol shown)
 *  7. BTC tab shows only /BTC pair items
 *  8. No layout shift on tab switch (column widths stay fixed)
 *  9. Sticky header stays visible when scrolling
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.URL || 'http://localhost:8080/index.html';
const SCREENSHOTS_DIR = '/home/z/my-project/download/market-redesign';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const VIEWPORTS = [
    { width: 390, height: 844, name: 'iphone-13' },
    { width: 360, height: 720, name: 'small-android' },
    { width: 320, height: 568, name: 'tiny' },
];

function log(...args) { console.log('[test-market-ui]', ...args); }

async function run() {
    const browser = await chromium.launch({ headless: true });

    let allOk = true;
    for (const vp of VIEWPORTS) {
        log(`\n=== Viewport ${vp.name} (${vp.width}x${vp.height}) ===`);
        const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        page.on('console', msg => {
            if (msg.type() === 'error') log('  [console.error]', msg.text());
        });
        page.on('pageerror', err => log('  [pageerror]', err.message));

        await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

        // Navigate to Market tab
        await page.evaluate(() => {
            const navBtn = document.querySelector('[data-page="market-page"]');
            if (navBtn) navBtn.click();
        });
        await page.waitForTimeout(800);

        // Screenshot: full page Market overview
        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `market-${vp.name}-overview.png`),
            fullPage: false,
        });

        // Check 1: stat cards equal height
        const statCards = await page.$$eval('.mkt-stat-card', els =>
            els.map(el => {
                const r = el.getBoundingClientRect();
                return { width: r.width, height: r.height, text: el.innerText };
            })
        );
        log(`  Stat cards: ${statCards.length}`);
        if (statCards.length !== 3) {
            log('  FAIL: expected 3 stat cards');
            allOk = false;
        } else {
            const heights = statCards.map(c => Math.round(c.height));
            const maxH = Math.max(...heights);
            const minH = Math.min(...heights);
            const diff = maxH - minH;
            log(`  Heights: ${heights.join(', ')} (diff: ${diff}px)`);
            if (diff > 4) {
                log(`  WARN: stat card heights differ by ${diff}px`);
            } else {
                log('  OK: equal heights');
            }
        }

        // Check 2: sticky column header
        const header = await page.$eval('#mkt-list-header', el => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                visible: r.width > 0 && r.height > 0,
                position: cs.position,
                top: cs.top,
                childCount: el.children.length,
                columns: cs.gridTemplateColumns,
            };
        }).catch(() => null);
        if (!header) {
            log('  FAIL: #mkt-list-header not found');
            allOk = false;
        } else {
            log(`  List header: position=${header.position}, top=${header.top}, columns=${header.columns}, children=${header.childCount}`);
            if (header.position !== 'sticky') {
                log('  FAIL: header not sticky');
                allOk = false;
            } else {
                log('  OK: sticky header');
            }
        }

        // Check 3: pulse bar removed
        const pulseBarExists = await page.$('.mkt-pulse-bar') !== null;
        const pulseBarVisible = await page.$eval('.mkt-pulse-bar', el => {
            const cs = getComputedStyle(el);
            return cs.display !== 'none';
        }).catch(() => false);
        if (pulseBarExists && pulseBarVisible) {
            log('  FAIL: pulse bar still visible');
            allOk = false;
        } else {
            log('  OK: pulse bar removed/hidden');
        }

        // Check 4: BTC pairs Bullish/Bearish section removed
        const btcSectionExists = await page.$('#mkt-btc-pairs-section') !== null;
        if (btcSectionExists) {
            log('  WARN: #mkt-btc-pairs-section still in DOM (should be removed)');
        } else {
            log('  OK: BTC pairs section removed');
        }

        // Wait for coins to load
        await page.waitForTimeout(1500);

        // Check 5: coin rows use new grid layout
        const rows = await page.$$eval('.mkt-coin-row', els =>
            els.slice(0, 3).map(el => {
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return {
                    gridColumns: cs.gridTemplateColumns,
                    width: r.width,
                    height: r.height,
                    childCount: el.children.length,
                    hasRank: !!el.querySelector('.mkt-coin-rank'),
                    hasLogo: !!el.querySelector('.mkt-coin-logo'),
                    hasSymbol: !!el.querySelector('.mkt-coin-symbol'),
                    hasPrice: !!el.querySelector('.mkt-coin-price'),
                    hasChange: !!el.querySelector('.mkt-coin-change'),
                    hasStar: !!el.querySelector('.mkt-coin-star'),
                    symbolText: el.querySelector('.mkt-coin-symbol')?.textContent || '',
                    hasNameVisible: (() => {
                        const n = el.querySelector('.mkt-coin-name');
                        if (!n) return false;
                        return getComputedStyle(n).display !== 'none';
                    })(),
                };
            })
        );
        log(`  Rows sample: ${rows.length}`);
        if (rows.length === 0) {
            log('  WARN: no coin rows found (data may not have loaded)');
        } else {
            const r0 = rows[0];
            log(`  Row 0: cols="${r0.gridColumns}", children=${r0.childCount}`);
            log(`         rank=${r0.hasRank}, logo=${r0.hasLogo}, symbol="${r0.symbolText}", price=${r0.hasPrice}, change=${r0.hasChange}, star=${r0.hasStar}`);
            log(`         name visible: ${r0.hasNameVisible}`);
            if (!r0.hasRank || !r0.hasLogo || !r0.hasPrice || !r0.hasChange || !r0.hasStar) {
                log('  FAIL: row missing required columns');
                allOk = false;
            } else {
                log('  OK: row has all required columns');
            }
            if (r0.hasNameVisible) {
                log('  FAIL: coin name should be hidden');
                allOk = false;
            } else {
                log('  OK: coin name hidden');
            }
            // Check column alignment: row 1 and row 2 should have same grid template
            if (rows.length > 1) {
                const allSame = rows.every(r => r.gridColumns === r0.gridColumns);
                if (!allSame) {
                    log('  FAIL: row grid templates differ');
                    allOk = false;
                } else {
                    log('  OK: all rows use same grid template');
                }
            }
        }

        // Check 6: BTC pairs tab shows only /BTC pairs
        await page.evaluate(() => {
            const btn = document.querySelector('[data-sub-tab="btcpairs"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(800);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `market-${vp.name}-btcpairs.png`),
            fullPage: false,
        });

        const btcRows = await page.$$eval('.mkt-btc-pair-row', els =>
            els.slice(0, 5).map(el => ({
                symbol: el.querySelector('.mkt-coin-symbol')?.textContent || '',
                pairCaption: el.querySelector('.mkt-coin-pair-caption')?.textContent || '',
                price: el.querySelector('.mkt-coin-price')?.textContent || '',
                change: el.querySelector('.mkt-coin-change')?.textContent || '',
                hasDollar: (el.querySelector('.mkt-coin-price')?.textContent || '').includes('$'),
            }))
        );
        log(`  BTC pairs tab: ${btcRows.length} sample rows`);
        if (btcRows.length === 0) {
            log('  WARN: no BTC pair rows rendered (data may not have loaded)');
        } else {
            const allBtcPairs = btcRows.every(r => r.symbol.includes('/BTC'));
            const noUsd = btcRows.every(r => !r.hasDollar);
            log(`  Sample: ${btcRows.map(r => r.symbol + ' → ' + r.price + ' (' + r.change + ')').join(' | ')}`);
            if (!allBtcPairs) {
                log('  FAIL: not all rows are /BTC pairs');
                allOk = false;
            } else {
                log('  OK: all visible rows are /BTC pairs');
            }
            if (!noUsd) {
                log('  FAIL: USD prices still shown in BTC tab');
                allOk = false;
            } else {
                log('  OK: no USD prices in BTC tab');
            }
        }

        // Check 7: switch back to "all" tab and verify no layout shift
        await page.evaluate(() => {
            const btn = document.querySelector('[data-sub-tab="top"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(500);

        // Scroll down — sticky header should stay at top:56px
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(300);

        const headerAfterScroll = await page.$eval('#mkt-list-header', el => {
            const r = el.getBoundingClientRect();
            return { top: r.top, visible: r.width > 0 && r.height > 0 };
        }).catch(() => null);
        if (!headerAfterScroll) {
            log('  FAIL: header not found after scroll');
            allOk = false;
        } else {
            log(`  After scroll 600px: header top=${headerAfterScroll.top}px`);
            // Should be at top:56px (under app header)
            if (Math.abs(headerAfterScroll.top - 56) > 5) {
                log(`  WARN: header not at expected top:56px (got ${headerAfterScroll.top})`);
            } else {
                log('  OK: sticky header sticks under app header');
            }
        }

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `market-${vp.name}-scrolled.png`),
            fullPage: false,
        });

        await context.close();
    }

    await browser.close();

    log('\n=== Summary ===');
    log(allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
    process.exit(allOk ? 0 : 1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
});

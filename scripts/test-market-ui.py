#!/usr/bin/env python3
"""
Headless browser test for the redesigned Market section.
Uses Python playwright which has proper network namespace access.
"""
import os
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://127.0.0.1:8090/index.html")
SCREENSHOTS_DIR = Path("/home/z/my-project/download/market-redesign")
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    {"width": 390, "height": 844, "name": "iphone-13"},
    {"width": 360, "height": 720, "name": "small-android"},
    {"width": 320, "height": 568, "name": "tiny"},
]


def log(*args):
    print("[test-market-ui]", *args)


def main():
    all_ok = True
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        for vp in VIEWPORTS:
            log(f"\n=== Viewport {vp['name']} ({vp['width']}x{vp['height']}) ===")
            context = browser.new_context(
                viewport={"width": vp["width"], "height": vp["height"]},
                device_scale_factor=2,
            )
            page = context.new_page()
            page.on("console", lambda msg: log(f"  [console.{msg.type}]", msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: log("  [pageerror]", err.message))

            try:
                page.goto(URL, wait_until="networkidle", timeout=30000)
            except Exception as e:
                log(f"  Failed to load page: {e}")
                all_ok = False
                context.close()
                continue

            # Navigate to Market tab
            page.evaluate("""() => {
                const navBtn = document.querySelector('[data-page="market-page"]');
                if (navBtn) navBtn.click();
            }""")
            page.wait_for_timeout(800)

            # Screenshot: full page Market overview
            page.screenshot(path=str(SCREENSHOTS_DIR / f"market-{vp['name']}-overview.png"), full_page=False)

            # Check 1: stat cards
            stat_cards = page.evaluate("""() => {
                return Array.from(document.querySelectorAll('.mkt-stat-card')).map(el => {
                    const r = el.getBoundingClientRect();
                    return { width: r.width, height: r.height, text: el.innerText };
                });
            }""")
            log(f"  Stat cards: {len(stat_cards)}")
            if len(stat_cards) != 3:
                log("  FAIL: expected 3 stat cards")
                all_ok = False
            else:
                heights = [round(c["height"]) for c in stat_cards]
                max_h = max(heights)
                min_h = min(heights)
                diff = max_h - min_h
                log(f"  Heights: {heights} (diff: {diff}px)")
                if diff > 4:
                    log(f"  WARN: stat card heights differ by {diff}px")
                else:
                    log("  OK: equal heights")

            # Check 2: sticky column header
            header = page.evaluate("""() => {
                const el = document.getElementById('mkt-list-header');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    visible: r.width > 0 && r.height > 0,
                    position: cs.position,
                    top: cs.top,
                    childCount: el.children.length,
                    columns: cs.gridTemplateColumns,
                };
            }""")
            if not header:
                log("  FAIL: #mkt-list-header not found")
                all_ok = False
            else:
                log(f"  List header: position={header['position']}, top={header['top']}, columns={header['columns']}, children={header['childCount']}")
                if header["position"] != "sticky":
                    log("  FAIL: header not sticky")
                    all_ok = False
                else:
                    log("  OK: sticky header")

            # Check 3: pulse bar removed
            pulse_visible = page.evaluate("""() => {
                const el = document.querySelector('.mkt-pulse-bar');
                if (!el) return false;
                return getComputedStyle(el).display !== 'none';
            }""")
            if pulse_visible:
                log("  FAIL: pulse bar still visible")
                all_ok = False
            else:
                log("  OK: pulse bar removed/hidden")

            # Check 4: BTC pairs Bullish/Bearish section removed
            btc_section_exists = page.evaluate("""() => document.getElementById('mkt-btc-pairs-section') !== null""")
            if btc_section_exists:
                log("  WARN: #mkt-btc-pairs-section still in DOM")
            else:
                log("  OK: BTC pairs section removed")

            # Wait for coins to load
            page.wait_for_timeout(2000)

            # Check 5: coin rows
            rows = page.evaluate("""() => {
                return Array.from(document.querySelectorAll('.mkt-coin-row')).slice(0, 3).map(el => {
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
                });
            }""")
            log(f"  Rows sample: {len(rows)}")
            if not rows:
                log("  WARN: no coin rows found (data may not have loaded)")
            else:
                r0 = rows[0]
                log(f"  Row 0: cols=\"{r0['gridColumns']}\", children={r0['childCount']}")
                log(f"         rank={r0['hasRank']}, logo={r0['hasLogo']}, symbol=\"{r0['symbolText']}\", price={r0['hasPrice']}, change={r0['hasChange']}, star={r0['hasStar']}")
                log(f"         name visible: {r0['hasNameVisible']}")
                if not all([r0["hasRank"], r0["hasLogo"], r0["hasPrice"], r0["hasChange"], r0["hasStar"]]):
                    log("  FAIL: row missing required columns")
                    all_ok = False
                else:
                    log("  OK: row has all required columns")
                if r0["hasNameVisible"]:
                    log("  FAIL: coin name should be hidden")
                    all_ok = False
                else:
                    log("  OK: coin name hidden")
                if len(rows) > 1:
                    all_same = all(r["gridColumns"] == r0["gridColumns"] for r in rows)
                    if not all_same:
                        log("  FAIL: row grid templates differ")
                        all_ok = False
                    else:
                        log("  OK: all rows use same grid template")

            # Check 6: BTC pairs tab
            page.evaluate("""() => {
                const btn = document.querySelector('[data-sub-tab="btcpairs"]');
                if (btn) btn.click();
            }""")
            page.wait_for_timeout(800)

            page.screenshot(path=str(SCREENSHOTS_DIR / f"market-{vp['name']}-btcpairs.png"), full_page=False)

            btc_rows = page.evaluate("""() => {
                return Array.from(document.querySelectorAll('.mkt-btc-pair-row')).slice(0, 5).map(el => ({
                    symbol: el.querySelector('.mkt-coin-symbol')?.textContent || '',
                    pairCaption: el.querySelector('.mkt-coin-pair-caption')?.textContent || '',
                    price: el.querySelector('.mkt-coin-price')?.textContent || '',
                    change: el.querySelector('.mkt-coin-change')?.textContent || '',
                    hasDollar: (el.querySelector('.mkt-coin-price')?.textContent || '').includes('$'),
                }));
            }""")
            log(f"  BTC pairs tab: {len(btc_rows)} sample rows")
            if not btc_rows:
                log("  WARN: no BTC pair rows rendered (data may not have loaded)")
            else:
                all_btc = all("/BTC" in r["symbol"] for r in btc_rows)
                no_usd = all(not r["hasDollar"] for r in btc_rows)
                sample = " | ".join(f"{r['symbol']} → {r['price']} ({r['change']})" for r in btc_rows)
                log(f"  Sample: {sample}")
                if not all_btc:
                    log("  FAIL: not all rows are /BTC pairs")
                    all_ok = False
                else:
                    log("  OK: all visible rows are /BTC pairs")
                if not no_usd:
                    log("  FAIL: USD prices still shown in BTC tab")
                    all_ok = False
                else:
                    log("  OK: no USD prices in BTC tab")

            # Check 7: switch back to all and verify sticky header after scroll
            page.evaluate("""() => {
                const btn = document.querySelector('[data-sub-tab="top"]');
                if (btn) btn.click();
            }""")
            page.wait_for_timeout(500)

            page.evaluate("() => window.scrollTo(0, 600)")
            page.wait_for_timeout(300)

            header_after = page.evaluate("""() => {
                const el = document.getElementById('mkt-list-header');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { top: r.top, visible: r.width > 0 && r.height > 0 };
            }""")
            if not header_after:
                log("  FAIL: header not found after scroll")
                all_ok = False
            else:
                log(f"  After scroll 600px: header top={header_after['top']}px")
                if abs(header_after["top"] - 56) > 5:
                    log(f"  WARN: header not at expected top:56px (got {header_after['top']})")
                else:
                    log("  OK: sticky header sticks under app header")

            page.screenshot(path=str(SCREENSHOTS_DIR / f"market-{vp['name']}-scrolled.png"), full_page=False)

            context.close()

        browser.close()

    log("\n=== Summary ===")
    log("ALL CHECKS PASSED" if all_ok else "SOME CHECKS FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

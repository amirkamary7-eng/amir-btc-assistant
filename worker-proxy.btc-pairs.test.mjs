/**
 * BTC Pairs Chart Resolution Tests
 *
 * Verifies that clicking a BTC pair (ETHBTC, SOLBTC, etc.) opens the correct
 * TradingView chart for that pair — NOT the USDT version.
 *
 * Bug: previously, clicking ETHBTC would open ETHUSDT because:
 *   1. data-symbol on BTC pair rows was just "ETH" (the base symbol)
 *   2. openCoinDetail("ETH") → resolveChartSymbol("ETH") → backend appends "USDT"
 *   3. Result: BINANCE:ETHUSDT chart (wrong)
 *
 * Fix: data-symbol now uses the full pair (ETHBTC), and resolveChartSymbol
 * detects BTC pairs and returns BINANCE:ETHBTC directly without calling backend.
 */

import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Replicate parseBtcPairSymbol logic from app.js for testing.
 */
function parseBtcPairSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (sym === 'BTC') return null;
    if (sym === 'BTCUSDT') return null;
    if (!sym.endsWith('BTC')) return null;
    const base = sym.slice(0, -3);
    if (base.length < 2) return null;
    if (!/^[A-Z0-9]+$/.test(base)) return null;
    if (base === 'BTC') return null;
    return base;
}

/**
 * Replicate resolveChartSymbol BTC pair shortcut logic.
 */
function resolveBtcPairChart(symbol) {
    const symUpper = String(symbol || '').toUpperCase().trim();
    if (symUpper !== 'BTC' && symUpper.endsWith('BTC') && symUpper.length > 3) {
        const base = symUpper.slice(0, -3);
        if (base.length >= 2 && /^[A-Z0-9]+$/.test(base) && base !== 'BTC') {
            return {
                found: true,
                symbol: symUpper,
                exchange: 'binance',
                tv_symbol: `BINANCE:${symUpper}`,
                cached: false,
                is_btc_pair: true,
            };
        }
    }
    return null;
}

test('BTC pair parsing: ETHBTC → ETH', () => {
    assert.equal(parseBtcPairSymbol('ETHBTC'), 'ETH');
    assert.equal(parseBtcPairSymbol('ethbtc'), 'ETH'); // case-insensitive
});

test('BTC pair parsing: SOLBTC → SOL', () => {
    assert.equal(parseBtcPairSymbol('SOLBTC'), 'SOL');
});

test('BTC pair parsing: AVAXBTC → AVAX', () => {
    assert.equal(parseBtcPairSymbol('AVAXBTC'), 'AVAX');
});

test('BTC pair parsing: XRPBTC → XRP', () => {
    assert.equal(parseBtcPairSymbol('XRPBTC'), 'XRP');
});

test('BTC pair parsing: LINKBTC → LINK', () => {
    assert.equal(parseBtcPairSymbol('LINKBTC'), 'LINK');
});

test('BTC pair parsing: DOGEBTC → DOGE', () => {
    assert.equal(parseBtcPairSymbol('DOGEBTC'), 'DOGE');
});

test('BTC pair parsing: BTC alone → null (not a pair)', () => {
    assert.equal(parseBtcPairSymbol('BTC'), null);
});

test('BTC pair parsing: ETH alone → null (regular coin)', () => {
    assert.equal(parseBtcPairSymbol('ETH'), null);
});

test('BTC pair parsing: ETHUSDT → null (explicit USDT pair)', () => {
    assert.equal(parseBtcPairSymbol('ETHUSDT'), null);
});

test('BTC pair parsing: empty/null/undefined → null', () => {
    assert.equal(parseBtcPairSymbol(''), null);
    assert.equal(parseBtcPairSymbol(null), null);
    assert.equal(parseBtcPairSymbol(undefined), null);
});

test('BTC pair parsing: rejects non-alphanumeric bases', () => {
    assert.equal(parseBtcPairSymbol('ET-BTC'), null);
    assert.equal(parseBtcPairSymbol('ET BTC'), null);
    assert.equal(parseBtcPairSymbol('ET.BTC'), null);
});

test('BTC pair chart resolution: ETHBTC → BINANCE:ETHBTC (NOT ETHUSDT)', () => {
    const r = resolveBtcPairChart('ETHBTC');
    assert.ok(r, 'Should resolve');
    assert.equal(r.tv_symbol, 'BINANCE:ETHBTC');
    assert.equal(r.is_btc_pair, true);
    assert.equal(r.exchange, 'binance');
    // Critical: must NOT contain USDT
    assert.ok(!r.tv_symbol.includes('USDT'), `tv_symbol should not contain USDT, got: ${r.tv_symbol}`);
});

test('BTC pair chart resolution: SOLBTC → BINANCE:SOLBTC', () => {
    const r = resolveBtcPairChart('SOLBTC');
    assert.equal(r.tv_symbol, 'BINANCE:SOLBTC');
    assert.ok(!r.tv_symbol.includes('USDT'));
});

test('BTC pair chart resolution: AVAXBTC → BINANCE:AVAXBTC', () => {
    const r = resolveBtcPairChart('AVAXBTC');
    assert.equal(r.tv_symbol, 'BINANCE:AVAXBTC');
    assert.ok(!r.tv_symbol.includes('USDT'));
});

test('BTC pair chart resolution: XRPBTC → BINANCE:XRPBTC', () => {
    const r = resolveBtcPairChart('XRPBTC');
    assert.equal(r.tv_symbol, 'BINANCE:XRPBTC');
    assert.ok(!r.tv_symbol.includes('USDT'));
});

test('BTC pair chart resolution: LINKBTC → BINANCE:LINKBTC', () => {
    const r = resolveBtcPairChart('LINKBTC');
    assert.equal(r.tv_symbol, 'BINANCE:LINKBTC');
    assert.ok(!r.tv_symbol.includes('USDT'));
});

test('BTC pair chart resolution: BTC alone → null (no chart shortcut)', () => {
    const r = resolveBtcPairChart('BTC');
    assert.equal(r, null);
});

test('BTC pair chart resolution: ETH alone → null (uses backend fallback)', () => {
    const r = resolveBtcPairChart('ETH');
    assert.equal(r, null);
});

test('BTC pair chart resolution: case-insensitive', () => {
    const r = resolveBtcPairChart('ethbtc');
    assert.ok(r);
    assert.equal(r.tv_symbol, 'BINANCE:ETHBTC');
});

test('BTC pair chart resolution: rejects malformed symbols', () => {
    assert.equal(resolveBtcPairChart(''), null);
    assert.equal(resolveBtcPairChart('BTCBTC'), null); // base = "BTC" which is invalid
    assert.equal(resolveBtcPairChart('XBTC'), null); // base = "X" too short (len=1)
    assert.equal(resolveBtcPairChart('ET-BTC'), null); // non-alphanumeric
});

test('All common BTC pairs resolve correctly', () => {
    const pairs = [
        'ETHBTC', 'SOLBTC', 'AVAXBTC', 'XRPBTC', 'LINKBTC',
        'DOGEBTC', 'ADABTC', 'DOTBTC', 'MATICBTC', 'LTCBTC',
        'BNBBTC', 'ATOMBTC', 'NEARBTC', 'ARBBTC', 'OPBTC',
    ];
    for (const pair of pairs) {
        const r = resolveBtcPairChart(pair);
        assert.ok(r, `${pair} should resolve`);
        assert.equal(r.tv_symbol, `BINANCE:${pair}`, `${pair} should map to BINANCE:${pair}`);
        assert.ok(!r.tv_symbol.includes('USDT'), `${pair} must not contain USDT`);
    }
});
